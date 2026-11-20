import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../vs.mjs';
import { mockServer, geminiResponse } from './helpers.mjs';
import { writeScript, testConnection, listModels } from '../web/lib/providers.js';
import { importProject, getProject } from '../web/lib/studio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const script = {
  title: 'Browser Cat',
  format: '9:16',
  music: 'lofi',
  scenes: [
    { start: 0, end: 3, visual: 'a cat looks at a kite', narration: 'Momo wants to fly.', onscreen: '', sound: 'wind' },
    { start: 3, end: 6, visual: 'the cat glides over the roof', narration: 'So she borrows the wind.', onscreen: 'wheee', sound: 'whoosh' },
  ],
};

async function withStudio(fn) {
  const server = createStudioServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('the studio serves the browser app and keeps the old UI', async () => {
  await withStudio(async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="modelBtn"/);

    const redirect = await fetch(`${base}/app`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/app/');

    const checks = [
      ['/app/', 'text/html'],
      ['/app/app.js', 'text/javascript'],
      ['/app/app.css', 'text/css'],
      ['/app/styles.json', 'application/json'],
      ['/app/favicon.svg', 'image/svg+xml'],
      ['/app/lib/scene.js', 'text/javascript'],
      ['/app/lib/prompt.js', 'text/javascript'],
      ['/app/lib/providers.js', 'text/javascript'],
    ];
    for (const [url, type] of checks) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, `${url} should be served`);
      assert.match(res.headers.get('content-type') || '', new RegExp(type.replace(/[+]/g, '\\+')), `${url} content type`);
    }
    const html = await (await fetch(`${base}/app/`)).text();
    assert.match(html, /id="settingsModal"/);
    assert.match(html, /src="\.\/app\.js"/);
    assert.match(html, /Pick a style/);
  });
});

test('a local page may read the API, other origins may not', async () => {
  await withStudio(async (base) => {
    const ok = await fetch(`${base}/api/settings`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.match(ok.headers.get('vary') || '', /Origin/);

    const bad = await fetch(`${base}/api/settings`, { headers: { Origin: 'https://example.com' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${base}/api/settings`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:5500', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5500');
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /PUT/);
  });
});

test('the browser copies match their server sources', () => {
  const pairs = [
    [['llm', 'json.mjs'], ['web', 'lib', 'scene.js']],
    [['llm', 'script-prompt.mjs'], ['web', 'lib', 'prompt.js']],
  ];
  for (const [src, copy] of pairs) {
    assert.equal(
      read(...copy), read(...src),
      `${copy.join('/')} is stale — run “npm run web:sync”`,
    );
  }
});

test('styles.json lists every style in the catalog', () => {
  const catalog = JSON.parse(read('catalog.json'));
  const styles = JSON.parse(read('web', 'styles.json'));
  const ids = (c) => c.tools.flatMap((t) => t.styles.map((s) => `${t.id}/${s.id}`)).sort();
  assert.deepEqual(ids(styles), ids(catalog));
  assert.deepEqual(styles.groups, catalog.groups);
  const first = styles.tools[0];
  assert.equal(first.what, catalog.tools[0].what);
  assert.equal(first.styles[0].name, catalog.tools[0].styles[0].name);
});

test('the browser writes a script through an OpenAI-compatible endpoint', async () => {
  const server = await mockServer((req) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-browser');
    assert.equal(req.body.model, 'gpt-browser');
    assert.equal(req.body.response_format.type, 'json_schema');
    return { json: { choices: [{ message: { role: 'assistant', content: `Sure:\n\`\`\`json\n${JSON.stringify(script)}\n\`\`\`` } }] } };
  });
  try {
    const out = await writeScript(
      { provider: 'openai', model: 'gpt-browser', baseUrl: `${server.url}/v1`, apiKey: 'sk-browser' },
      { prompt: 'a cat learns to fly', style: 'tvhead/prehistoric', styleName: 'Prehistoric', toolWhat: 'paper cutouts' },
    );
    assert.equal(out.data.title, 'Browser Cat');
    assert.equal(out.data.scenes.length, 2);
    assert.equal(out.model, 'gpt-browser');
  } finally { await server.close(); }
});

test('the browser drops json_schema when the endpoint rejects it', async () => {
  const server = await mockServer((req) => {
    if (req.body?.response_format?.type === 'json_schema') {
      return { status: 400, json: { error: { message: 'response_format json_schema is not supported by this model' } } };
    }
    assert.equal(req.body.response_format.type, 'json_object');
    return { json: { choices: [{ message: { content: JSON.stringify(script) } }] } };
  });
  try {
    const out = await writeScript(
      { provider: 'local', model: 'qwen', baseUrl: `${server.url}/v1`, apiKey: '' },
      { prompt: 'a cat learns to fly', style: 'tvhead/prehistoric', styleName: 'Prehistoric', toolWhat: 'paper cutouts' },
    );
    assert.equal(out.data.title, 'Browser Cat');
    assert.equal(out.attempt, 'json_object');
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1].headers.authorization, undefined);
  } finally { await server.close(); }
});

test('the browser talks to Gemini with a response schema', async () => {
  const server = await mockServer((req) => {
    assert.match(req.url, /^\/v1beta\/models\/gemini-browser:generateContent\?key=k-test/);
    assert.equal(req.method, 'POST');
    assert.equal(req.body.generationConfig.responseSchema.type, 'OBJECT');
    assert.match(req.body.systemInstruction.parts[0].text, /short-form video director/);
    return { json: geminiResponse({ text: JSON.stringify(script) }) };
  });
  try {
    const out = await writeScript(
      { provider: 'gemini', model: 'gemini-browser', baseUrl: `${server.url}/v1beta`, apiKey: 'k-test' },
      { prompt: 'a cat learns to fly', style: 'tvhead/prehistoric', styleName: 'Prehistoric', toolWhat: 'paper cutouts' },
    );
    assert.equal(out.data.title, 'Browser Cat');
  } finally { await server.close(); }
});

test('the browser checks connections and lists models', async () => {
  const server = await mockServer((req) => {
    if (req.url === '/v1/models') return { json: { data: [{ id: 'm-one' }, { id: 'm-two' }] } };
    if (req.url.startsWith('/v1beta/models?pageSize=100')) {
      return { json: { models: [
        { name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
      ] } };
    }
    return { status: 404, json: { error: { message: 'not found' } } };
  });
  try {
    const openai = { provider: 'openai', model: 'm-one', baseUrl: `${server.url}/v1`, apiKey: 'sk' };
    const ping = await testConnection(openai);
    assert.equal(ping.ok, true);
    assert.equal(ping.models.length, 2);
    assert.deepEqual(await listModels(openai), ['m-one', 'm-two']);

    const gemini = { provider: 'gemini', model: 'gemini-flash', baseUrl: `${server.url}/v1beta`, apiKey: 'k' };
    assert.deepEqual(await listModels(gemini), ['gemini-flash']);
  } finally { await server.close(); }
});

test('the browser retries with max_completion_tokens when max_tokens is rejected', async () => {
  const server = await mockServer((req) => {
    if (req.body.max_tokens !== undefined) {
      return { status: 400, json: { error: { message: 'Unsupported parameter: max_tokens. Use max_completion_tokens instead.' } } };
    }
    assert.ok(req.body.max_completion_tokens > 0);
    return { json: { choices: [{ message: { content: JSON.stringify(script) } }] } };
  });
  try {
    const out = await writeScript(
      { provider: 'openai', model: 'o-browser', baseUrl: `${server.url}/v1`, apiKey: 'sk' },
      { prompt: 'a cat learns to fly', style: 'tvhead/prehistoric', styleName: 'Prehistoric', toolWhat: 'paper cutouts' },
    );
    assert.equal(out.data.title, 'Browser Cat');
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1].body.max_tokens, undefined);
  } finally { await server.close(); }
});


test('a browser project is handed to the studio with its scenes', async () => {
  const title = `webtest-${Date.now().toString(36)}`;
  const project = {
    title, idea: 'a cat learns to fly', format: '9:16', music: 'lofi', style: 'tvhead/prehistoric', styleName: 'Prehistoric',
    scenes: [{ n: 1, start: 0, end: 3, tool: 'tvhead/prehistoric', visual: 'a cat looks up', narration: 'Momo wants to fly.', onscreen: '', sound: 'wind', notes: '' }],
  };
  await withStudio(async (base) => {
    const slug = await importProject(base, project);
    try {
      assert.match(slug, /^webtest-/);
      const p = await getProject(base, slug);
      assert.equal(p.title, title);
      assert.equal(p.scenes.length, 1);
      assert.equal(p.scenes[0].visual, 'a cat looks up');
      assert.equal(p.status, 'script-ready');
      assert.equal(p.style, 'tvhead/prehistoric');
    } finally {
      fs.rmSync(path.join(ROOT, 'projects', slug), { recursive: true, force: true });
    }
  });
});
