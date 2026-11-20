import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ensureLocalServer, llamaServerArgs, localBaseUrl, pickModel, stopLocalServer } from '../llm/local.mjs';
import { resolveConfig } from '../llm/config.mjs';
import { mockServer, tempDir } from './helpers.mjs';

const fakeChild = () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  return child;
};

test('llama-server arguments cover model, host, port, context and GPU layers', () => {
  const cfg = { ctxSize: 8192, gpuLayers: 'auto', localPort: 8081 };
  const args = llamaServerArgs(cfg, { ggufPath: '/models/tiny.gguf', port: 8081 });
  assert.deepEqual(args.slice(0, 2), ['-m', '/models/tiny.gguf']);
  assert.ok(args.includes('--host') && args.includes('127.0.0.1'));
  assert.equal(args[args.indexOf('--port') + 1], '8081');
  assert.equal(args[args.indexOf('-c') + 1], '8192');
  assert.equal(args[args.indexOf('-ngl') + 1], '999');
  assert.ok(args.includes('--jinja'));

  const cpu = llamaServerArgs({ ctxSize: 4096, gpuLayers: '0' }, { ggufPath: 'x.gguf', port: 9000 });
  assert.equal(cpu[cpu.indexOf('-ngl') + 1], '0');
});

test('local base URL follows the runtime', () => {
  assert.equal(localBaseUrl({ localRuntime: 'ollama' }), 'http://127.0.0.1:11434/v1');
  assert.equal(localBaseUrl({ localRuntime: 'lmstudio' }), 'http://127.0.0.1:1234/v1');
  assert.equal(localBaseUrl({ localRuntime: 'auto', localPort: 8088 }), 'http://127.0.0.1:8088/v1');
  assert.equal(localBaseUrl({ baseUrlExplicit: true, baseUrl: 'http://gpu-box:8080/v1' }), 'http://gpu-box:8080/v1');
});

test('an already-running server is reused, not spawned', async () => {
  const server = await mockServer((req) => {
    if (req.url === '/v1/models') return { json: { data: [{ id: 'qwen2.5-7b-instruct' }] } };
    return undefined;
  });
  try {
    const cfg = resolveConfig({ file: { provider: 'local', baseUrl: server.url + '/v1' }, env: {} });
    let spawned = false;
    const info = await ensureLocalServer(cfg, { spawnImpl: () => { spawned = true; return fakeChild(); } });
    assert.equal(info.spawned, false);
    assert.equal(spawned, false);
    assert.equal(info.model, 'qwen2.5-7b-instruct');
  } finally { await server.close(); }
});

test('spawns llama-server for a GGUF file and waits until it answers', async () => {
  const dir = tempDir();
  const gguf = path.join(dir, 'tiny.gguf');
  fs.writeFileSync(gguf, Buffer.alloc(2 * 1024 * 1024));
  let calls = [];
  let child;
  const spawnImpl = (bin, args) => {
    calls.push({ bin, args });
    child = fakeChild();
    const port = Number(args[args.indexOf('--port') + 1]);
    const started = mockServer((req) => (req.url === '/v1/models' ? { json: { data: [{ id: 'tiny-local' }] } } : undefined));
    started.then((s) => {
      // the mock always binds :0, so expose its real port via a proxy-free endpoint is not possible;
      // instead stop it and start one on the requested port
      s.close().then(() => {
        import('node:http').then(({ default: http }) => {
          const srv = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'tiny-local' }] }));
          });
          srv.listen(port, '127.0.0.1');
          child._server = srv;
        });
      });
    });
    return child;
  };
  const cfg = resolveConfig({
    file: { provider: 'local', baseUrl: 'http://127.0.0.1:47811/v1', ggufPath: gguf, ctxSize: 2048, gpuLayers: 'auto' },
    env: {},
  });
  try {
    const info = await ensureLocalServer(cfg, { spawnImpl, loadTimeoutMs: 8000 });
    assert.equal(info.spawned, true);
    assert.equal(info.model, 'tiny-local');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], gguf);
    assert.ok(calls[0].args.includes('--jinja'));
  } finally {
    stopLocalServer();
    child?._server?.close();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('a missing GGUF file is reported before spawning anything', async () => {
  const cfg = resolveConfig({ file: { provider: 'local', baseUrl: 'http://127.0.0.1:47812/v1', ggufPath: '/nope/model.gguf' }, env: {} });
  await assert.rejects(() => ensureLocalServer(cfg, { spawnImpl: () => { throw new Error('should not spawn'); } }), (e) => e.code === 'gguf-missing');
});

test('an offline Ollama gets the right hint', async () => {
  const cfg = resolveConfig({ file: { provider: 'local', localRuntime: 'ollama', baseUrl: 'http://127.0.0.1:47813/v1' }, env: {} });
  await assert.rejects(() => ensureLocalServer(cfg), (e) => e.code === 'local-offline' && /ollama serve/.test(e.hint));
});

test('pickModel prefers what the server reports', () => {
  assert.equal(pickModel({ buildModel: 'qwen2.5:14b' }, ['qwen2.5:14b']), 'qwen2.5:14b');
  assert.equal(pickModel({ buildModel: 'local' }, ['first']), 'first');
  assert.equal(pickModel({ buildModel: 'wrong' }, ['first']), 'first');
  assert.equal(pickModel({ buildModel: 'local' }, []), 'local');
});

test('a remote base URL with a GGUF file is not served locally by mistake', async () => {
  const dir = tempDir();
  const gguf = path.join(dir, 'tiny.gguf');
  fs.writeFileSync(gguf, Buffer.alloc(2 * 1024 * 1024));
  const cfg = resolveConfig({ file: { provider: 'local', baseUrl: 'http://gpu-box:8080/v1', ggufPath: gguf }, env: {} });
  await assert.rejects(
    () => ensureLocalServer(cfg, { spawnImpl: () => { throw new Error('must not spawn'); } }),
    (e) => e.code === 'local-offline' && /remote machine/.test(e.hint),
  );
});
