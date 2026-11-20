// Model backends for Video Studio: which model writes the script and builds the video.
//
//   claude  — Claude Code CLI (your Claude plan; no API key). The default, so an existing
//             install keeps behaving exactly as before.
//   gemini  — Google Gemini API (GEMINI_API_KEY / GOOGLE_API_KEY).
//   openai  — OpenAI GPT API (OPENAI_API_KEY).
//   local   — a .gguf model run by llama.cpp's llama-server (spawned for you), Ollama or
//             LM Studio, all through their OpenAI-compatible /v1 endpoints.
//
// Settings live in video-studio/llm.config.json (git-ignored, mode 600) and can be overridden
// with environment variables. Secrets are never handed to the browser: the UI only learns
// whether a key is set.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // video-studio/
export const BUILD_DIR = path.resolve(VS_DIR, '..');
export const CONFIG_PATH = path.resolve(process.env.VS_CONFIG || path.join(VS_DIR, 'llm.config.json'));

export const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    kind: 'claude',
    needsKey: false,
    models: { script: 'sonnet', build: 'opus' },
    hint: 'Uses the Claude Code CLI and your Claude plan (Pro or Max). No API key. Install it from https://claude.com/claude-code and run `claude` once to log in.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: { script: 'gemini-2.5-flash', build: 'gemini-2.5-pro' },
    envKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'An API key from Google AI Studio. gemini-2.5-flash writes scripts quickly; gemini-2.5-pro is better at the long build jobs.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI GPT',
    kind: 'openai',
    needsKey: true,
    baseUrl: 'https://api.openai.com/v1',
    models: { script: 'gpt-4.1-mini', build: 'gpt-4.1' },
    envKey: ['OPENAI_API_KEY'],
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'An API key from platform.openai.com. Any OpenAI-compatible endpoint also works: put its URL in Base URL (OpenRouter, Groq, Together…).',
  },
  local: {
    id: 'local',
    label: 'Local GGUF model',
    kind: 'openai',
    needsKey: false,
    baseUrl: 'http://127.0.0.1:8080/v1',
    models: { script: 'local', build: 'local' },
    hint: 'Point this at a .gguf file and llama.cpp’s llama-server is started for you, or leave the file empty and start Ollama / LM Studio / llama-server yourself (set Base URL). Tools work best with Qwen2.5/3, Llama 3.1+ or Mistral models.',
  },
};

export const DEFAULTS = {
  provider: 'claude',
  scriptModel: '',
  buildModel: '',
  baseUrl: '',
  apiKey: '',
  // local (GGUF)
  ggufPath: '',
  llamaServer: '',
  localRuntime: 'auto', // auto | llama.cpp | ollama | lmstudio | server
  localPort: 8080,
  ctxSize: 16384,
  gpuLayers: 'auto',
  // behaviour
  temperature: 0.6,
  maxSteps: 160,
  timeoutMs: 900000,
  toolMode: 'auto', // auto | native | text
};

const PROVIDER_ALIASES = {
  'claude-code': 'claude', anthropic: 'claude',
  google: 'gemini', 'google-gemini': 'gemini',
  gpt: 'openai', 'open-ai': 'openai', 'openai-compatible': 'openai', openrouter: 'openai', groq: 'openai',
  gguf: 'local', llama: 'local', 'llama.cpp': 'local', llamacpp: 'local', llama_server: 'local', ollama: 'local', lmstudio: 'local', 'lm-studio': 'local', 'local-llm': 'local', localai: 'local',
};

export class ConfigError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

export function normalizeProvider(value, fallback = DEFAULTS.provider) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (PROVIDERS[v]) return v;
  return PROVIDER_ALIASES[v] || fallback;
}

export function readFileConfig(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object');
    return raw;
  } catch (e) {
    throw new ConfigError(`could not read ${file}: ${e.message}`, 'Fix the JSON, or delete the file to start again.');
  }
}

function envNumber(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Environment variables win over the saved file, so CI and shells can override safely. */
export function applyEnv(fileCfg = {}, env = process.env) {
  const cfg = { ...fileCfg };
  const set = (key, ...names) => { for (const n of names) if (env[n] !== undefined && env[n] !== '') { cfg[key] = env[n]; return true; } return false; };

  set('provider', 'VS_PROVIDER');
  set('scriptModel', 'VS_SCRIPT_MODEL');
  set('buildModel', 'VS_BUILD_MODEL');
  set('baseUrl', 'VS_BASE_URL', 'VS_LLM_BASE_URL');
  const explicitKey = set('apiKey', 'VS_API_KEY', 'VS_LLM_API_KEY');
  set('ggufPath', 'VS_GGUF_PATH', 'GGUF_PATH', 'VS_GGUF');
  set('llamaServer', 'VS_LLAMA_SERVER', 'LLAMA_SERVER');
  set('localRuntime', 'VS_LOCAL_RUNTIME');
  set('gpuLayers', 'VS_GPU_LAYERS');
  set('toolMode', 'VS_TOOL_MODE');
  if (env.VS_LLAMA_PORT) cfg.localPort = envNumber(env, 'VS_LLAMA_PORT', cfg.localPort);
  if (env.VS_LLAMA_CTX) cfg.ctxSize = envNumber(env, 'VS_LLAMA_CTX', cfg.ctxSize);
  if (env.VS_MAX_STEPS) cfg.maxSteps = envNumber(env, 'VS_MAX_STEPS', cfg.maxSteps);
  if (env.VS_LLM_TIMEOUT) cfg.timeoutMs = envNumber(env, 'VS_LLM_TIMEOUT', cfg.timeoutMs);
  if (env.VS_TEMPERATURE) cfg.temperature = envNumber(env, 'VS_TEMPERATURE', cfg.temperature);

  // provider-specific keys: environment beats the saved file, so shells and CI can override
  const provider = normalizeProvider(cfg.provider);
  if (explicitKey) cfg.apiKeyFromEnv = env.VS_API_KEY ? 'VS_API_KEY' : 'VS_LLM_API_KEY';
  for (const name of explicitKey ? [] : PROVIDERS[provider]?.envKey || []) {
    if (env[name]) { cfg.apiKey = env[name]; cfg.apiKeyFromEnv = name; break; }
  }
  return cfg;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Merge defaults + saved file + env into the config every caller uses. */
export function resolveConfig({ file, env = process.env } = {}) {
  const saved = file ?? readFileConfig();
  const cfg = { ...DEFAULTS, ...saved };
  const withEnv = applyEnv(cfg, env);

  withEnv.provider = normalizeProvider(withEnv.provider);
  const preset = PROVIDERS[withEnv.provider];
  const baseUrlExplicit = !!String(withEnv.baseUrl || '').trim();

  const localPort = positiveNumber(withEnv.localPort, DEFAULTS.localPort);
  const runtime = String(withEnv.localRuntime || 'auto').trim().toLowerCase();
  // Local servers each have their own default port; a GGUF file means llama.cpp on localPort.
  const localDefaultBase = runtime === 'ollama' ? 'http://127.0.0.1:11434/v1'
    : runtime === 'lmstudio' ? 'http://127.0.0.1:1234/v1'
      : `http://127.0.0.1:${localPort}/v1`;

  const baseUrl = String(withEnv.baseUrl || (withEnv.provider === 'local' ? localDefaultBase : preset.baseUrl) || '').trim();
  const scriptModel = String(withEnv.scriptModel || preset.models.script || '').trim();
  const buildModel = String(withEnv.buildModel || preset.models.build || scriptModel).trim();

  return {
    ...withEnv,
    provider: withEnv.provider,
    preset,
    label: preset.label,
    baseUrl,
    baseUrlExplicit,
    scriptModel,
    buildModel,
    apiKey: String(withEnv.apiKey || '').trim(),
    ggufPath: String(withEnv.ggufPath || '').trim(),
    llamaServer: String(withEnv.llamaServer || '').trim(),
    localRuntime: String(withEnv.localRuntime || 'auto').trim().toLowerCase(),
    localPort,
    ctxSize: positiveNumber(withEnv.ctxSize, DEFAULTS.ctxSize),
    gpuLayers: withEnv.gpuLayers === '' ? 'auto' : withEnv.gpuLayers,
    temperature: Number.isFinite(Number(withEnv.temperature)) ? Number(withEnv.temperature) : DEFAULTS.temperature,
    maxSteps: positiveNumber(withEnv.maxSteps, DEFAULTS.maxSteps),
    timeoutMs: positiveNumber(withEnv.timeoutMs, DEFAULTS.timeoutMs),
    toolMode: ['auto', 'native', 'text'].includes(withEnv.toolMode) ? withEnv.toolMode : 'auto',
    configPath: CONFIG_PATH,
  };
}

/** "Gemini · gemini-2.5-pro" — safe to show and log (never contains the key). */
export function describeConfig(cfg) {
  if (cfg.provider === 'claude') return `${cfg.label} · ${cfg.buildModel}`;
  if (cfg.provider === 'local') {
    const model = cfg.buildModel && cfg.buildModel !== 'local' ? cfg.buildModel : cfg.ggufPath ? path.basename(cfg.ggufPath) : 'local model';
    return `${cfg.label} · ${model}`;
  }
  return `${cfg.label} · ${cfg.buildModel || cfg.scriptModel}`;
}

let claudeCheck = { at: 0, value: null };

/** Is the Claude Code CLI installed and logged in? Cached briefly. */
export function claudeReady({ force = false } = {}) {
  const now = Date.now();
  if (!force && claudeCheck.value && now - claudeCheck.at < 30000) return claudeCheck.value;
  const run = (args) => spawnSync('claude', args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 15000 });
  const version = run(['--version']);
  let value = { ok: false, detail: 'Claude Code CLI not found' };
  if (version.status === 0 && (version.stdout || version.stderr)) {
    const status = run(['auth', 'status']);
    const text = `${status.stdout || ''}${status.stderr || ''}`;
    const loggedIn = /"loggedIn"\s*:\s*true/.test(text) || /logged.?in/i.test(text);
    value = {
      ok: loggedIn,
      detail: loggedIn ? `Claude Code ${String(version.stdout || '').trim().split(' ')[0]}` : 'Claude Code is installed but not logged in — run `claude` once',
    };
  }
  claudeCheck = { at: now, value };
  return value;
}

/** Can this provider actually answer right now? */
export function readiness(cfg, { env = process.env } = {}) {
  if (cfg.provider === 'claude') {
    const c = claudeReady();
    return { ok: c.ok, detail: c.detail, hint: PROVIDERS.claude.hint };
  }
  if (cfg.provider === 'gemini' || cfg.provider === 'openai') {
    if (cfg.apiKey) return { ok: true, detail: cfg.apiKeyFromEnv ? `key from ${cfg.apiKeyFromEnv}` : 'API key saved' };
    const names = (PROVIDERS[cfg.provider].envKey || []).join(' or ');
    return { ok: false, detail: `no API key — add one in Model settings or set ${names}`, hint: PROVIDERS[cfg.provider].hint, keyUrl: PROVIDERS[cfg.provider].keyUrl };
  }
  // local: a reachable server or a GGUF file is enough to try
  if (cfg.ggufPath) {
    return fs.existsSync(cfg.ggufPath)
      ? { ok: true, detail: `GGUF ${path.basename(cfg.ggufPath)}${fs.statSync(cfg.ggufPath).size ? '' : ' (empty file!)'}` }
      : { ok: false, detail: `GGUF file not found: ${cfg.ggufPath}`, hint: 'Check the path, or start Ollama / LM Studio and set Base URL instead.' };
  }
  // no file, but a server may already be running at baseUrl — we cannot probe synchronously here
  return { ok: true, unknown: true, detail: `will use the local server at ${cfg.baseUrl} (not checked yet)`, hint: PROVIDERS.local.hint };
}

/** Everything the browser may see: settings + readiness, with the secret replaced by a flag. */
export function publicConfig(cfg, { env = process.env } = {}) {
  const ready = readiness(cfg, { env });
  const preset = PROVIDERS[cfg.provider];
  return {
    provider: cfg.provider,
    label: cfg.label,
    description: describeConfig(cfg),
    scriptModel: cfg.scriptModel,
    buildModel: cfg.buildModel,
    baseUrl: cfg.baseUrl,
    hasApiKey: !!cfg.apiKey,
    apiKeyFromEnv: cfg.apiKeyFromEnv || null,
    keyEnv: preset.envKey || [],
    keyUrl: preset.keyUrl || null,
    ggufPath: cfg.ggufPath,
    ggufName: cfg.ggufPath ? path.basename(cfg.ggufPath) : '',
    llamaServer: cfg.llamaServer,
    localRuntime: cfg.localRuntime,
    localPort: cfg.localPort,
    ctxSize: cfg.ctxSize,
    gpuLayers: cfg.gpuLayers,
    toolMode: cfg.toolMode,
    maxSteps: cfg.maxSteps,
    temperature: cfg.temperature,
    timeoutMs: cfg.timeoutMs,
    ready: ready.ok,
    unknown: !!ready.unknown,
    readyDetail: ready.detail,
    hint: preset.hint,
    configPath: CONFIG_PATH,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id, label: p.label, needsKey: p.needsKey, kind: p.kind,
      models: p.models, hint: p.hint, keyEnv: p.envKey || [], keyUrl: p.keyUrl || null, baseUrl: p.baseUrl || '',
    })),
  };
}

/** Read the settings file; if it is broken, keep a .bak copy and start over instead of failing forever. */
function readOrRecover(file) {
  if (!fs.existsSync(file)) return {};
  try { return readFileConfig(file); }
  catch {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* ignore */ }
    return {};
  }
}

const SAVED_KEYS = [
  'provider', 'scriptModel', 'buildModel', 'baseUrl', 'apiKey', 'ggufPath', 'llamaServer',
  'localRuntime', 'localPort', 'ctxSize', 'gpuLayers', 'temperature', 'maxSteps', 'timeoutMs', 'toolMode',
];

function coerce(key, value) {
  if (value === undefined) return undefined;
  if (key === 'provider') return normalizeProvider(value);
  if (['localPort', 'ctxSize', 'maxSteps', 'timeoutMs', 'temperature'].includes(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (key === 'toolMode') return ['auto', 'native', 'text'].includes(value) ? value : 'auto';
  if (key === 'localRuntime') {
    const v = String(value).toLowerCase();
    return ['auto', 'llama.cpp', 'llamacpp', 'ollama', 'lmstudio', 'server'].includes(v) ? (v === 'llamacpp' ? 'llama.cpp' : v) : 'auto';
  }
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Persist a patch. An empty apiKey means "keep the saved key", so the UI can show a
 * password box without ever receiving the secret back.
 */
function mergePatch(current, patch) {
  const next = { ...current };
  const switching = patch.provider !== undefined && normalizeProvider(patch.provider) !== normalizeProvider(current.provider || DEFAULTS.provider);
  // values that belong to the old provider must not leak into the new one
  if (switching) {
    delete next.baseUrl; delete next.scriptModel; delete next.buildModel;
    if (!patch.apiKey) delete next.apiKey; // a key for the old provider is useless (and unsafe) for the new one
  }
  for (const key of SAVED_KEYS) {
    if (!(key in patch)) continue;
    const value = coerce(key, patch[key]);
    if (value === undefined) continue;
    if (key === 'apiKey' && !value) continue; // keep the existing key
    next[key] = value;
  }
  return next;
}

export function saveConfig(patch = {}, { file = CONFIG_PATH } = {}) {
  const current = readOrRecover(file);
  const next = mergePatch(current, patch);
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  return resolveConfig({ file: next });
}

/** Resolve the saved config with an unsaved patch on top (Test / Load models before saving). */
export function previewConfig(patch = {}, { file = CONFIG_PATH, env = process.env } = {}) {
  const current = fs.existsSync(file) ? readOrRecover(file) : {};
  return resolveConfig({ file: mergePatch(current, patch), env });
}

/** Forget the saved API key (used by "Remove key" in the UI). */
export function clearApiKey({ file = CONFIG_PATH } = {}) {
  if (!fs.existsSync(file)) return resolveConfig({ file: {} });
  const current = readOrRecover(file);
  delete current.apiKey;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return resolveConfig({ file: current });
}

/** One-line summary for the progress log. */
export function backendLine(cfg, purpose = 'build') {
  const model = purpose === 'script' ? cfg.scriptModel : cfg.buildModel;
  return `${cfg.label} · ${model}`;
}
