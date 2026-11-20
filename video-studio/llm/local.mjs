// Local GGUF models. Three ways to run one:
//   1. point at a .gguf file — llama.cpp's llama-server is spawned and managed for you;
//   2. start `llama-server` yourself and just set Base URL;
//   3. use Ollama or LM Studio (they serve the same OpenAI-compatible /v1 API).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LlmError, getJson, probe } from './http.mjs';
import { proxyFetch } from './net.mjs';

const RUNTIME_DOCS = {
  ollama: 'For Ollama: run `ollama serve` and put the model in Ollama first (`ollama pull qwen2.5:14b`, or import your GGUF with `ollama create mymodel -f Modelfile`). Base URL: http://127.0.0.1:11434/v1.',
  lmstudio: 'For LM Studio: start its Local Server (Developer tab), load the GGUF model, and use Base URL http://127.0.0.1:1234/v1.',
  'llama.cpp': 'For llama.cpp: install llama-server (https://github.com/ggml-org/llama.cpp/releases, `brew install llama.cpp`, or `winget install llama.cpp`), or set the GGUF path here and Video Studio starts it for you.',
  auto: 'Start Ollama (`ollama serve`), LM Studio’s local server, or llama-server, or set a .gguf path so llama-server is started for you.',
};

export function localBaseUrl(cfg) {
  if (cfg.baseUrlExplicit && cfg.baseUrl) return cfg.baseUrl.replace(/\/+$/, '');
  if (cfg.localRuntime === 'ollama') return 'http://127.0.0.1:11434/v1';
  if (cfg.localRuntime === 'lmstudio') return 'http://127.0.0.1:1234/v1';
  return `http://127.0.0.1:${cfg.localPort || 8080}/v1`;
}

/** llama-server arguments for a GGUF file. Exported so the tests can check them. */
export function llamaServerArgs(cfg, { ggufPath, port } = {}) {
  const model = ggufPath || cfg.ggufPath;
  const p = port || cfg.localPort || 8080;
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(p), '-c', String(cfg.ctxSize || 16384)];
  const layers = cfg.gpuLayers;
  if (layers === 'auto' || layers === '' || layers === null || layers === undefined) args.push('-ngl', '999');
  else if (Number.isFinite(Number(layers)) && Number(layers) >= 0) args.push('-ngl', String(Number(layers)));
  args.push('--jinja'); // use the model's own chat template, which is what enables tool calling
  const extra = String(process.env.VS_LLAMA_ARGS || '').trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  return args;
}

export async function listLocalModels(baseUrl, { fetchImpl = proxyFetch() } = {}) {
  try {
    const json = await getJson(`${baseUrl.replace(/\/+$/, '')}/models`, { timeoutMs: 4000, fetchImpl });
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  } catch { return null; }
}

function tail(lines, n = 24) {
  return lines.slice(-n).join('\n').trim();
}

let server = null; // { child, baseUrl, ggufPath, port, log: [] }
let exitHook = false;

function remember(child, meta) {
  server = { ...meta, child };
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => { try { server?.child?.kill(); } catch { /* gone */ } });
  }
}

export function stopLocalServer() {
  if (!server) return false;
  try { server.child.kill(); } catch { /* already gone */ }
  server = null;
  return true;
}

export function localServerStatus() {
  if (!server) return null;
  return { pid: server.child.pid, baseUrl: server.baseUrl, ggufPath: server.ggufPath, port: server.port, running: server.child.exitCode === null };
}

function spawnServer(cfg, { ggufPath, port, log, spawnImpl, env }) {
  const bin = cfg.llamaServer || process.env.VS_LLAMA_SERVER || process.env.LLAMA_SERVER || 'llama-server';
  const args = llamaServerArgs(cfg, { ggufPath, port });
  const lines = [];
  log?.(`starting llama-server for ${path.basename(ggufPath)} on port ${port} (first load can take a minute)…`);
  let child;
  try {
    child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
  } catch (e) {
    throw new LlmError(`could not start llama-server: ${e.message}`, { code: 'llama-server', hint: RUNTIME_DOCS['llama.cpp'] });
  }
  const collect = (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) lines.push(line.trim());
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
  child.stdout?.on?.('data', collect);
  child.stderr?.on?.('data', collect);
  let exited = null;
  child.on?.('error', (e) => { exited = e; });
  child.on?.('exit', (code, sig) => { if (exited === null) exited = new Error(`llama-server exited (${code ?? sig})`); });
  return { child, lines, getExited: () => exited, bin };
}

/**
 * Make sure something answers at the local endpoint. Spawns llama-server when a GGUF
 * path is configured and nothing is listening.
 */
export async function ensureLocalServer(cfg, {
  log, fetchImpl = proxyFetch(), spawnImpl = spawn, env = process.env,
  loadTimeoutMs = Number(process.env.VS_LLAMA_LOAD_TIMEOUT) > 0 ? Number(process.env.VS_LLAMA_LOAD_TIMEOUT) * 1000 : 240000,
  signal,
} = {}) {
  const baseUrl = localBaseUrl(cfg);
  const up = await probe(`${baseUrl}/models`, { fetchImpl, timeoutMs: 3000 });
  if (up.ok) {
    const models = await listLocalModels(baseUrl, { fetchImpl });
    return { baseUrl, models: models || [], spawned: false, model: pickModel(cfg, models) };
  }

  const runtime = cfg.localRuntime || 'auto';
  if (runtime === 'ollama' || runtime === 'lmstudio' || runtime === 'server') {
    throw new LlmError(`no local model server at ${baseUrl}`, {
      code: 'local-offline',
      hint: RUNTIME_DOCS[runtime] || RUNTIME_DOCS.auto,
    });
  }

  if (!cfg.ggufPath) {
    throw new LlmError(`no local model server at ${baseUrl} and no GGUF file set`, { code: 'local-offline', hint: RUNTIME_DOCS.auto });
  }
  if (!fs.existsSync(cfg.ggufPath)) {
    throw new LlmError(`GGUF file not found: ${cfg.ggufPath}`, { code: 'gguf-missing', hint: 'Check the path in Model settings (a .gguf file downloaded from Hugging Face).' });
  }
  const size = fs.statSync(cfg.ggufPath).size;
  if (size < 1024 * 1024) {
    throw new LlmError(`GGUF file looks empty or incomplete: ${cfg.ggufPath} (${size} bytes)`, { code: 'gguf-empty', hint: 'Download the model again; .gguf files are usually 1–40 GB.' });
  }

  const target = new URL(baseUrl);
  if (!/^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)$/i.test(target.hostname)) {
    throw new LlmError(`no model server at ${baseUrl}`, {
      code: 'local-offline',
      hint: 'A .gguf file can only be served on this machine. Start llama-server on that remote machine and leave the GGUF file empty here, or fix the Base URL.',
    });
  }
  const port = Number(target.port) || cfg.localPort || 8080;
  if (server && server.child.exitCode === null && server.port === port && server.ggufPath === cfg.ggufPath) {
    const models = await listLocalModels(baseUrl, { fetchImpl });
    return { baseUrl, models: models || [], spawned: false, model: pickModel(cfg, models) };
  }
  stopLocalServer();

  const { child, lines, getExited, bin } = spawnServer(cfg, { ggufPath: cfg.ggufPath, port, log, spawnImpl, env });
  remember(child, { baseUrl, ggufPath: cfg.ggufPath, port });

  const deadline = Date.now() + loadTimeoutMs;
  let lastNote = Date.now();
  while (Date.now() < deadline) {
    if (signal?.aborted) { try { child.kill(); } catch { /* gone */ } throw new LlmError('stopped while loading the local model', { code: 'aborted' }); }
    const err = getExited();
    if (err) {
      stopLocalServer();
      const detail = tail(lines);
      const enoent = err.code === 'ENOENT' || /ENOENT/.test(err.message);
      throw new LlmError(
        enoent ? `llama-server was not found (${bin})` : `llama-server stopped while loading the model: ${err.message}${detail ? `\n${detail}` : ''}`,
        { code: enoent ? 'llama-server-missing' : 'llama-server-failed', hint: enoent ? RUNTIME_DOCS['llama.cpp'] : 'Check that the GGUF file is a valid chat/instruct model and that your GPU/driver supports it. Set GPU layers to 0 to run on the CPU.' },
      );
    }
    const ready = await probe(`${baseUrl}/models`, { fetchImpl, timeoutMs: 2000 });
    if (ready.ok) {
      const models = await listLocalModels(baseUrl, { fetchImpl });
      log?.(`local model ready (${models?.[0] || path.basename(cfg.ggufPath)})`);
      return { baseUrl, models: models || [], spawned: true, model: pickModel(cfg, models) };
    }
    if (Date.now() - lastNote > 15000) { lastNote = Date.now(); log?.('still loading the local model…'); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopLocalServer();
  throw new LlmError('the local model did not finish loading in time', { code: 'llama-timeout', hint: 'Try a smaller GGUF (Q4_K_M of a 7–14B model), raise VS_LLAMA_LOAD_TIMEOUT, or lower the context size.' });
}

export function pickModel(cfg, models = []) {
  const wanted = String(cfg.buildModel || '').trim();
  const list = models || [];
  if (wanted && wanted !== 'local' && (!list.length || list.includes(wanted))) return wanted;
  if (list.length) return list[0];
  return wanted && wanted !== 'local' ? wanted : 'local';
}
