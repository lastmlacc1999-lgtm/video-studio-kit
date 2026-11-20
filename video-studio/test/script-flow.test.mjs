import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockServer, chatResponse, tempDir } from './helpers.mjs';

const dir = tempDir('vs-script-');
process.env.VS_CONFIG = path.join(dir, 'llm.config.json');
for (const k of ['VS_PROVIDER', 'VS_API_KEY', 'VS_LLM_API_KEY', 'VS_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

const { writeScript } = await import('../agent.mjs');

const script = {
  title: 'The Flying Cat',
  format: '9:16',
  music: 'lofi',
  scenes: [
    { start: 0, end: 3, visual: 'a cat eyes a paper kite', narration: 'Momo wants to fly.', onscreen: '', sound: 'wind' },
    { start: 3, end: 6, visual: 'the cat leaps and glides', narration: 'So she borrows the wind.', onscreen: 'wheee', sound: 'whoosh' },
  ],
};

async function waitFor(slug, predicate, timeoutMs = 8000) {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'projects', slug, 'project.json');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (predicate(p)) return p;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${slug}`);
}

test('a non-Claude provider writes a script end to end', async () => {
  const server = await mockServer((req) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    assert.equal(req.body.model, 'gpt-script');
    assert.equal(req.body.response_format.type, 'json_schema');
    return {
      json: chatResponse({
        content: `Here you go:\n\`\`\`json\n${JSON.stringify(script, null, 2)}\n\`\`\``,
      }),
    };
  });
  fs.writeFileSync(process.env.VS_CONFIG, JSON.stringify({
    provider: 'openai', baseUrl: server.url + '/v1', apiKey: 'sk-test',
    scriptModel: 'gpt-script', buildModel: 'gpt-build',
  }));
  try {
    const slug = await writeScript('a cat learns to fly', '9:16', 'tvhead/prehistoric');
    assert.match(slug, /a-cat-learns-to-fly/);
    const p = await waitFor(slug, (x) => x.status === 'script-ready' || x.status === 'error');
    assert.equal(p.status, 'script-ready', JSON.stringify(p.log));
    assert.equal(p.title, 'The Flying Cat');
    assert.equal(p.scenes.length, 2);
    assert.equal(p.scenes[0].tool, 'tvhead/prehistoric');
    assert.equal(p.llm.provider, 'openai');
    assert.match(p.log[0].text, /OpenAI GPT · gpt-script is writing the script/);
    fs.rmSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'projects', slug), { recursive: true, force: true });
  } finally { await server.close(); }
});

test('a model that answers with prose leaves a readable error in the project', async () => {
  const server = await mockServer(() => ({ json: chatResponse({ content: 'Sorry, I cannot make videos.' }) }));
  fs.writeFileSync(process.env.VS_CONFIG, JSON.stringify({
    provider: 'openai', baseUrl: server.url + '/v1', apiKey: 'sk-test',
    scriptModel: 'gpt-script', buildModel: 'gpt-build',
  }));
  try {
    const slug = await writeScript('a cat learns to fly', '9:16', 'tvhead/prehistoric');
    const p = await waitFor(slug, (x) => x.status === 'error');
    const text = p.log.map((l) => l.text).join('\n');
    assert.match(text, /Script failed: the model did not return JSON/);
    fs.rmSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'projects', slug), { recursive: true, force: true });
  } finally { await server.close(); }
});
