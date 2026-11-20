import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mockServer, chatResponse, tempDir } from './helpers.mjs';

// The server reads VS_CONFIG once at import time, so point it at a throwaway file first.
const dir = tempDir('vs-api-');
process.env.VS_CONFIG = path.join(dir, 'llm.config.json');
for (const k of ['VS_PROVIDER', 'VS_API_KEY', 'VS_LLM_API_KEY', 'VS_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

const { createStudioServer } = await import('../vs.mjs');

async function withServer(fn) {
  const server = createStudioServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

const get = async (base, p) => (await fetch(base + p)).json();
const send = async (base, p, method, body) => (await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

test('settings round-trip without ever exposing the key', async () => {
  await withServer(async (base) => {
    let s = await get(base, '/api/settings');
    assert.equal(s.provider, 'claude');
    assert.equal(s.hasApiKey, false);
    assert.equal(s.providers.length, 4);

    const saved = await send(base, '/api/settings', 'PUT', {
      provider: 'gemini', apiKey: 'super-secret', scriptModel: 'gemini-2.5-flash', buildModel: 'gemini-2.5-pro',
    });
    assert.equal(saved.provider, 'gemini');
    assert.equal(saved.hasApiKey, true);
    assert.equal(JSON.stringify(saved).includes('super-secret'), false);

    const disk = JSON.parse(fs.readFileSync(process.env.VS_CONFIG, 'utf8'));
    assert.equal(disk.apiKey, 'super-secret');
    if (process.platform !== 'win32') assert.equal(fs.statSync(process.env.VS_CONFIG).mode & 0o777, 0o600);

    s = await get(base, '/api/settings');
    assert.equal(JSON.stringify(s).includes('super-secret'), false);
    assert.equal(s.description, 'Google Gemini · gemini-2.5-pro');
  });
});

test('Test connection calls the chosen endpoint and reports a readable failure', async () => {
  const good = await mockServer(() => ({ json: chatResponse({ content: 'ready' }) }));
  const bad = await mockServer(() => ({ status: 401, json: { error: { message: 'Invalid API key' } } }));
  try {
    await withServer(async (base) => {
      const ok = await send(base, '/api/settings/test', 'POST', {
        provider: 'openai', apiKey: 'sk-x', baseUrl: good.url + '/v1', scriptModel: 'gpt-test', buildModel: 'gpt-test',
      });
      assert.equal(ok.ok, true);
      assert.match(ok.reply, /ready/);

      const fail = await send(base, '/api/settings/test', 'POST', {
        provider: 'openai', apiKey: 'sk-bad', baseUrl: bad.url + '/v1', scriptModel: 'gpt-test', buildModel: 'gpt-test',
      });
      assert.equal(fail.ok, false);
      assert.match(fail.error, /401/);
      assert.match(fail.hint, /API key/);
    });
  } finally { await good.close(); await bad.close(); }
});

test('Load models lists what the endpoint offers', async () => {
  const server = await mockServer((req) => (req.url === '/v1/models'
    ? { json: { data: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }] } }
    : { json: chatResponse({ content: 'ready' }) }));
  try {
    await withServer(async (base) => {
      const saved = await send(base, '/api/settings', 'PUT', {
        provider: 'openai', apiKey: 'sk-x', baseUrl: server.url + '/v1',
      });
      assert.equal(saved.provider, 'openai');
      const out = await get(base, '/api/settings/models');
      assert.deepEqual(out.models, ['gpt-4.1', 'gpt-4.1-mini']);
    });
  } finally { await server.close(); }
});

test('removing the saved key keeps the rest of the settings', async () => {
  await withServer(async (base) => {
    await send(base, '/api/settings', 'PUT', { provider: 'openai', apiKey: 'sk-remove-me' });
    const after = await send(base, '/api/settings', 'PUT', { clearApiKey: true });
    assert.equal(after.hasApiKey, false);
    assert.equal(after.provider, 'openai');
    const disk = JSON.parse(fs.readFileSync(process.env.VS_CONFIG, 'utf8'));
    assert.equal(disk.apiKey, undefined);
    assert.equal(disk.provider, 'openai');
  });
});

test('a bad config file does not take the UI down and can be repaired by saving', async () => {
  fs.writeFileSync(process.env.VS_CONFIG, '{ not json');
  await withServer(async (base) => {
    const s = await get(base, '/api/settings');
    assert.equal(s.provider, 'claude'); // sensible fallback
    assert.ok(s.error);
    const r = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"provider":"gemini","apiKey":"k"}' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).provider, 'gemini');
  });
  assert.match(fs.readFileSync(process.env.VS_CONFIG + '.bak', 'utf8'), /not json/);
  fs.rmSync(process.env.VS_CONFIG, { force: true });
  fs.rmSync(process.env.VS_CONFIG + '.bak', { force: true });
});
