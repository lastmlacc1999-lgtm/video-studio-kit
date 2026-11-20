// One entry point for every backend: build a client, ask for JSON, run the tool agent.
import { LlmError } from './http.mjs';
import { extractJson } from './json.mjs';
import { openaiClient } from './openai.mjs';
import { geminiClient } from './gemini.mjs';
import { ensureLocalServer, listLocalModels, localBaseUrl, stopLocalServer } from './local.mjs';
import { claudeReady, describeConfig } from './config.mjs';
import { proxyFetch } from './net.mjs';

export { LlmError } from './http.mjs';
export { stopLocalServer } from './local.mjs';

/** A ready-to-call client for the configured backend. Throws with an actionable hint. */
export async function createClient(cfg, purpose = 'build', { onLog, signal, fetchImpl = proxyFetch(), spawnImpl, timeoutMs } = {}) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeoutMs;
  if (cfg.provider === 'claude') {
    const ready = claudeReady();
    if (!ready.ok) {
      throw new LlmError(ready.detail, {
        code: 'claude-cli',
        hint: 'Install Claude Code and log in, or pick Gemini, OpenAI or a local GGUF model in Model settings.',
      });
    }
    return { kind: 'claude', label: cfg.label, model: purpose === 'script' ? cfg.scriptModel : cfg.buildModel, chat: null };
  }

  if (cfg.provider === 'gemini') {
    if (!cfg.apiKey) throw new LlmError('Gemini needs an API key', { code: 'auth', hint: 'Add it in Model settings, or set GEMINI_API_KEY / GOOGLE_API_KEY.' });
    return geminiClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: purpose === 'script' ? cfg.scriptModel : cfg.buildModel,
      timeoutMs: limit,
      providerLabel: cfg.label,
      fetchImpl,
    });
  }

  if (cfg.provider === 'local') {
    const info = await ensureLocalServer(cfg, { onLog, fetchImpl, signal, spawnImpl });
    const wanted = purpose === 'script' ? cfg.scriptModel : cfg.buildModel;
    const model = wanted && wanted !== 'local' && (!info.models.length || info.models.includes(wanted)) ? wanted : info.model;
    return openaiClient({
      baseUrl: info.baseUrl,
      apiKey: cfg.apiKey,
      model,
      timeoutMs: limit,
      providerLabel: cfg.label,
      fetchImpl,
    });
  }

  // openai (or any OpenAI-compatible endpoint)
  if (!cfg.apiKey) {
    throw new LlmError(`${cfg.label} needs an API key`, { code: 'auth', hint: 'Add it in Model settings, or set OPENAI_API_KEY / VS_API_KEY.' });
  }
  return openaiClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: purpose === 'script' ? cfg.scriptModel : cfg.buildModel,
    timeoutMs: limit,
    providerLabel: cfg.label,
    fetchImpl,
  });
}

/** Ask the model for one JSON object (the script). */
export async function requestJson(cfg, { system, prompt, schema, purpose = 'script', signal, onLog, fetchImpl = proxyFetch() } = {}) {
  const client = await createClient(cfg, purpose, { onLog, signal, fetchImpl });
  const res = await client.chat({
    system,
    messages: [{ role: 'user', content: prompt }],
    jsonSchema: schema,
    temperature: cfg.temperature,
    signal,
    toolMode: 'none',
  });
  const data = extractJson(res.text);
  return { data, text: res.text, client };
}

export function modelLabel(cfg, purpose = 'build') {
  const model = purpose === 'script' ? cfg.scriptModel : cfg.buildModel;
  return `${cfg.label} · ${model}`;
}

/** "Test connection" in Model settings. */
export async function testConnection(cfg, { signal, fetchImpl = proxyFetch(), spawnImpl } = {}) {
  const started = Date.now();
  const client = await createClient(cfg, 'script', {
    onLog: () => {}, signal, fetchImpl, spawnImpl,
    timeoutMs: Math.min(Number(cfg.timeoutMs) || 60000, 60000),
  });
  if (client.kind === 'claude') {
    return { ok: true, reply: 'Claude Code CLI is installed and logged in', model: client.model, label: client.label, ms: Date.now() - started };
  }
  const res = await client.chat({
    messages: [{ role: 'user', content: 'Reply with exactly one word: ready' }],
    signal,
    toolMode: 'none',
  });
  return {
    ok: true,
    reply: String(res.text || '').trim().slice(0, 200) || '(empty reply)',
    model: client.model,
    label: client.label,
    ms: Date.now() - started,
  };
}

/** Populate the model picker. */
export async function listModels(cfg, { signal, fetchImpl = proxyFetch(), spawnImpl } = {}) {
  if (cfg.provider === 'claude') {
    return { models: ['sonnet', 'opus', 'haiku'], note: 'Claude Code aliases; any full model name works too.' };
  }
  if (cfg.provider === 'local') {
    const baseUrl = localBaseUrl(cfg);
    let models = await listLocalModels(baseUrl, { fetchImpl });
    let spawned = false;
    if (!models) {
      const info = await ensureLocalServer(cfg, { fetchImpl, spawnImpl, signal });
      models = info.models; spawned = info.spawned;
    }
    return { models: models || [], note: spawned ? 'Started llama-server for your GGUF file.' : `From ${baseUrl}.` };
  }
  const client = await createClient(cfg, 'script', { fetchImpl, spawnImpl, signal });
  const models = await client.listModels();
  return { models, note: describeConfig(cfg) };
}
