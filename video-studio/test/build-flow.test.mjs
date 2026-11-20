import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockServer, chatResponse, tempDir } from './helpers.mjs';

const dir = tempDir('vs-build-');
process.env.VS_CONFIG = path.join(dir, 'llm.config.json');
for (const k of ['VS_PROVIDER', 'VS_API_KEY', 'VS_LLM_API_KEY', 'VS_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

const { buildProject, save, load, stopBuild, isRunning } = await import('../agent.mjs');
const VS_DIR = path.dirname(new URL(import.meta.url).pathname) + '/..';
const PROJECTS = path.join(VS_DIR, 'projects');

function makeProject(slug) {
  save({
    slug, title: slug, idea: 'test', format: '9:16', style: 'tvhead/prehistoric', styleName: 'Prehistoric',
    voice: { engine: 'kokoro', voice: 'none', on: false }, music: 'lofi', status: 'script-ready',
    scenes: [{ n: 1, start: 0, end: 3, tool: 'tvhead/prehistoric', visual: 'a cat', narration: '', onscreen: '', sound: '', notes: '', status: 'pending' }],
    notes: [], log: [], final: null, createdAt: new Date().toISOString(),
  });
}

const waitFor = async (slug, predicate, timeoutMs = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const p = load(slug);
    if (predicate(p)) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out; log: ${load(slug).log.map((l) => l.text).join(' | ')}`);
};

test('a Gemini/GPT/local style build runs the shell and finishes the project', async () => {
  const slug = 'build-flow-test';
  const project = path.join(PROJECTS, slug);
  fs.rmSync(project, { recursive: true, force: true });
  makeProject(slug);
  const finish = [
    `node -e "require('fs').mkdirSync(process.argv[1],{recursive:true})" "${project}/clips"`,
    `node -e "require('fs').writeFileSync(process.argv[1],'not-a-real-video')" "${project}/clips/scene-01.mp4"`,
    `node "${VS_DIR}/vs.mjs" progress ${slug} "scene 1 rendered" --scene 1 --clip clips/scene-01.mp4`,
    `node -e "require('fs').writeFileSync(process.argv[1],'not-a-real-video')" "${project}/final.mp4"`,
    `node "${VS_DIR}/vs.mjs" done ${slug} final.mp4`,
  ].join(' && ');

  const server = await mockServer((req, requests) => {
    if (requests.length === 1) {
      assert.ok(Array.isArray(req.body.tools) && req.body.tools.length >= 5, 'the build gets the tool definitions');
      const task = req.body.messages.find((m) => m.role === 'user').content;
      assert.match(task, /## The scene table/);
      assert.match(task, /"visual": "a cat"/);
      assert.match(task, /## The style\(s\) to build it with/);
      assert.match(task, /tvhead\/prehistoric/);
      assert.match(task, /skill: \.claude\/skills\/tvhead-video/);
      assert.doesNotMatch(task, /"styles":/, 'the whole 32 KB catalog is not dumped into the prompt');
      return { json: chatResponse({ toolCalls: [{ name: 'bash', arguments: { command: finish } }] }) };
    }
    return { json: chatResponse({ content: 'DONE: rendered and stitched' }) };
  });
  fs.writeFileSync(process.env.VS_CONFIG, JSON.stringify({
    provider: 'openai', baseUrl: server.url + '/v1', apiKey: 'sk-test',
    scriptModel: 'gpt-script', buildModel: 'gpt-build', maxSteps: 10,
  }));
  try {
    buildProject(slug);
    const p = await waitFor(slug, (x) => x.status === 'done' || x.status === 'error');
    for (let i = 0; i < 100 && isRunning(slug); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.status, 'done', p.log.map((l) => l.text).join('\n'));
    assert.equal(p.scenes[0].clip, 'clips/scene-01.mp4');
    const text = p.log.map((l) => l.text).join('\n');
    assert.match(text, /OpenAI GPT · gpt-build started building the video/);
    assert.match(text, /scene 1 rendered/);
    assert.ok(server.requests.length >= 2, `the model was asked to wrap up after the tools ran (${server.requests.length} calls)`);
  } finally {
    await server.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a failed provider call lands in the project log instead of throwing', async () => {
  const slug = 'build-fail-test';
  fs.rmSync(path.join(PROJECTS, slug), { recursive: true, force: true });
  makeProject(slug);
  const server = await mockServer(() => ({ status: 401, json: { error: { message: 'bad key' } } }));
  fs.writeFileSync(process.env.VS_CONFIG, JSON.stringify({
    provider: 'openai', baseUrl: server.url + '/v1', apiKey: 'bad', scriptModel: 'x', buildModel: 'x',
  }));
  try {
    buildProject(slug);
    const p = await waitFor(slug, (x) => x.status === 'error');
    for (let i = 0; i < 100 && isRunning(slug); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(p.log.map((l) => l.text).join('\n'), /Build failed: .*401/);
  } finally {
    await server.close();
    fs.rmSync(path.join(PROJECTS, slug), { recursive: true, force: true });
  }
});

test('Stop kills a running build and puts the project back to script-ready', async () => {
  const slug = 'build-stop-test';
  fs.rmSync(path.join(PROJECTS, slug), { recursive: true, force: true });
  makeProject(slug);
  const server = await mockServer(() => ({
    json: chatResponse({ toolCalls: [{ name: 'bash', arguments: { command: 'node -e "setTimeout(()=>{}, 20000)"' } }] }),
  }));
  fs.writeFileSync(process.env.VS_CONFIG, JSON.stringify({
    provider: 'openai', baseUrl: server.url + '/v1', apiKey: 'sk-test', scriptModel: 'x', buildModel: 'x', maxSteps: 10,
  }));
  try {
    buildProject(slug);
    await waitFor(slug, (p) => p.log.some((l) => /started building/.test(l.text)));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(stopBuild(slug), true);
    const p = await waitFor(slug, (x) => x.status === 'script-ready');
    assert.ok(p.log.some((l) => /Build stopped/.test(l.text)));
    assert.equal(stopBuild(slug), false);
  } finally {
    await server.close();
    fs.rmSync(path.join(PROJECTS, slug), { recursive: true, force: true });
  }
});
