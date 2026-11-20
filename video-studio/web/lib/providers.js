// Direct model calls from the browser: Gemini, any OpenAI-compatible endpoint, and local
// llama.cpp / Ollama / LM Studio servers. No studio server is involved, so the API key never
// leaves this page. Handles the same capability ladder as the server (schema → JSON mode → plain,
// temperature dropped when a reasoning model rejects it) and returns parsed JSON for the app.
import { SCENE_SCHEMA, extractJson, toGeminiSchema } from './scene.js';
import { SCRIPT_SYSTEM, scriptInput } from './prompt.js';

export const PROVIDERS = {
  gemini: {
    id: 'gemini', label: 'Google Gemini', short: 'Gemini',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'A key from Google AI Studio. Requests go straight from this page to Google.',
  },
  openai: {
    id: 'openai', label: 'OpenAI GPT', short: 'OpenAI',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'OpenAI, or any OpenAI-compatible endpoint (OpenRouter, Groq, Together, vLLM…).',
  },
  local: {
    id: 'local', label: 'Local model', short: 'Local',
    model: '',
    baseUrl: 'http://127.0.0.1:8080/v1',
    hint: 'llama.cpp (:8080), Ollama (:11434) or LM Studio (:1234). Keep the /v1 suffix.',
  },
};

export class ProviderError extends Error {
  constructor(message, { hint = '', code = '', status = 0, capability = '', retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.hint = hint;
    this.code = code;
    this.status = status;
    this.capability = capability;
    this.retryable = retryable;
  }
}

export const providerLabel = (id) => (PROVIDERS[id] || PROVIDERS.gemini).label;
const trimBase = (s, fallback) => String(s || fallback || '').trim().replace(/\/+$/, '');
const auth = (key) => (key ? { Authorization: `Bearer ${key}` } : {});
const snippet = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 180);

function networkHint(url, provider) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  if (provider === 'local' || /^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)) {
    return 'Is the local model server running? Start Ollama, LM Studio or llama-server. For Ollama, allow this page with OLLAMA_ORIGINS=* (it denies unknown web origins by default).';
  }
  return 'The API could not be reached from this page. Check the URL and your network; if the endpoint does not allow browser requests (CORS), use the studio server backend instead.';
}

function httpError(res, data, text, provider) {
  const msg = data?.error?.message || data?.error?.error?.message || data?.message
    || snippet(text) || `HTTP ${res.status}`;
  const capability = /response_?format|json_?schema|response_?schema|\bschema\b/i.test(msg) ? 'schema'
    : /temperature/i.test(msg) ? 'temperature'
      : /max_?completion_?tokens|max_?tokens/i.test(msg) ? 'tokens' : '';
  const code = res.status === 401 || res.status === 403 ? 'auth'
    : res.status === 404 ? 'not-found'
      : res.status === 429 ? 'rate'
        : res.status >= 500 ? 'server' : 'http';
  const hints = {
    auth: provider === 'local'
      ? 'The local server rejected the request. If it needs a key, add it; otherwise leave the key empty.'
      : 'Check the API key in the model settings. It may be wrong, expired, or for a different provider.',
    'not-found': provider === 'gemini'
      ? 'That model name is not available to this key. Try “gemini-2.5-flash”, or press Load models.'
      : 'Check the model name and the Base URL (it usually ends in /v1). Press Load models to see what the server offers.',
    rate: 'The provider is rate limiting or out of quota. Wait a moment or use a smaller model.',
    server: 'The provider had a temporary problem. Try again in a moment.',
    http: provider === 'local'
      ? 'The server answered with an error. Check that the model name matches what the server has loaded.'
      : 'The API rejected the request. Check the model, the Base URL and the key.',
  };
  return new ProviderError(msg, {
    hint: hints[code], status: res.status, code, capability,
    retryable: (capability && [400, 404, 422, 500].includes(res.status)) || res.status >= 500,
  });
}

async function request(url, init, { signal, fetchImpl, provider, timeoutMs = 180000 }) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('Cancelled', { code: 'aborted' });
    if (timedOut) {
      throw new ProviderError(`The model took longer than ${Math.round(timeoutMs / 1000)} s to answer`, {
        code: 'timeout', hint: 'Try a smaller model, a shorter idea, or a local model with a smaller context.',
      });
    }
    throw new ProviderError(`Could not reach ${(() => { try { return new URL(url).host; } catch { return 'the model'; } })()}`, {
      code: 'network', hint: networkHint(url, provider),
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) throw httpError(res, data, text, provider);
  return data ?? {};
}

function messageText(data) {
  const c = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  if (Array.isArray(c)) return c.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return String(c || '');
}

function parseContent(text) {
  if (!String(text || '').trim()) {
    throw new ProviderError('the model returned an empty answer', {
      code: 'empty', retryable: true, hint: 'The model may have run out of output tokens. Try a shorter idea or a larger max output.',
    });
  }
  try {
    return extractJson(text);
  } catch {
    throw new ProviderError('the model did not return JSON', {
      code: 'bad-json', retryable: true, hint: `It said: “${snippet(text)}”`,
    });
  }
}

async function openaiJson(cfg, { system, input, signal, fetchImpl }) {
  const base = trimBase(cfg.baseUrl, PROVIDERS.openai.baseUrl);
  const url = `${base}/chat/completions`;
  const attempts = [
    { name: 'json_schema', response_format: { type: 'json_schema', json_schema: { name: 'video_script', strict: true, schema: SCENE_SCHEMA } } },
    { name: 'json_object', response_format: { type: 'json_object' } },
    { name: 'plain', response_format: null },
  ];
  let temperature = 0.6;
  let tokenParam = 'max_tokens';
  let last = null;
  for (const attempt of attempts) {
    for (let pass = 0; pass < 3; pass++) {
      const body = {
        model: cfg.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
        [tokenParam]: 4096,
      };
      if (attempt.response_format) body.response_format = attempt.response_format;
      if (temperature !== null) body.temperature = temperature;
      try {
        const data = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth(cfg.apiKey) },
          body: JSON.stringify(body),
        }, { signal, fetchImpl, provider: cfg.provider });
        return { data: parseContent(messageText(data)), raw: messageText(data), attempt: attempt.name, usage: data.usage };
      } catch (e) {
        last = e;
        if (e.code === 'aborted') throw e;
        if (e.capability === 'temperature' && temperature !== null) { temperature = null; continue; }
        if (e.capability === 'tokens' && tokenParam === 'max_tokens') { tokenParam = 'max_completion_tokens'; continue; }
        break;
      }
    }
    if (!last || !last.retryable) break;
  }
  throw last || new ProviderError('The model did not answer', { code: 'empty' });
}

async function geminiJson(cfg, { system, input, signal, fetchImpl }) {
  if (!cfg.apiKey) {
    throw new ProviderError('A Gemini API key is needed', {
      code: 'auth', hint: 'Add one in model settings — create it at https://aistudio.google.com/apikey.',
    });
  }
  const base = trimBase(cfg.baseUrl, PROVIDERS.gemini.baseUrl);
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const baseConfig = { temperature: 0.6, maxOutputTokens: 8192 };
  const attempts = [
    { name: 'schema', config: { ...baseConfig, responseMimeType: 'application/json', responseSchema: toGeminiSchema(SCENE_SCHEMA) } },
    { name: 'json', config: { ...baseConfig, responseMimeType: 'application/json' } },
    { name: 'plain', config: { ...baseConfig } },
  ];
  let last = null;
  for (const attempt of attempts) {
    try {
      const data = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: input }] }],
          generationConfig: attempt.config,
        }),
      }, { signal, fetchImpl, provider: cfg.provider });
      const blocked = data.promptFeedback?.blockReason;
      if (blocked) throw new ProviderError(`Gemini blocked the prompt (${blocked})`, { code: 'blocked', hint: 'Try a different idea or wording.' });
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts || []).map((part) => part?.text || '').join('');
      if (!String(text).trim()) {
        const finish = candidate?.finishReason;
        throw new ProviderError(finish ? `Gemini stopped without an answer (${finish})` : 'Gemini returned an empty answer', {
          code: 'empty', retryable: finish !== 'SAFETY' && finish !== 'PROHIBITED_CONTENT',
          hint: finish === 'SAFETY' ? 'The safety filter stopped this idea. Try different wording.' : 'Try again, or use a shorter idea.',
        });
      }
      return { data: parseContent(text), raw: text, attempt: attempt.name, usage: data.usageMetadata };
    } catch (e) {
      last = e;
      if (e.code === 'aborted') throw e;
      if (!e.retryable) break;
    }
  }
  throw last || new ProviderError('Gemini did not answer', { code: 'empty' });
}

function requireModel(cfg) {
  if (!cfg.model) {
    throw new ProviderError('Choose a model first', {
      code: 'config', hint: 'Open model settings, type the model name (or press Load models) and save.',
    });
  }
}

/** Write a script with the configured provider. Returns { data, raw, attempt, usage, model }. */
export async function writeScript(cfg, {
  prompt, format = '9:16', style, styleName, toolWhat, signal, fetchImpl = globalThis.fetch,
} = {}) {
  if (!style || !styleName) throw new ProviderError('Pick a style first', { code: 'config', hint: 'The style controls how every scene looks.' });
  if (!String(prompt || '').trim()) throw new ProviderError('Describe the video first', { code: 'config' });
  if (!fetchImpl) throw new ProviderError('This browser cannot make network requests', { code: 'network' });
  requireModel(cfg);
  if (!PROVIDERS[cfg.provider]) throw new ProviderError(`Unknown provider “${cfg.provider}”`, { code: 'config' });
  if (cfg.provider === 'gemini' && !cfg.apiKey) {
    throw new ProviderError('A Gemini API key is needed', {
      code: 'auth', hint: 'Add one in model settings — you can create one at https://aistudio.google.com/apikey.',
    });
  }
  const system = SCRIPT_SYSTEM;
  const input = scriptInput({ prompt: String(prompt).trim(), format, styleName, style, toolWhat: toolWhat || '' });
  const out = cfg.provider === 'gemini'
    ? await geminiJson(cfg, { system, input, signal, fetchImpl })
    : await openaiJson(cfg, { system, input, signal, fetchImpl });
  return { ...out, model: cfg.model };
}

function modelIds(data) {
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  return [...new Set(rows.map((m) => String(m?.id || m?.name || m || '').replace(/^models\//, '')).filter(Boolean))];
}

/** Probe the provider (and the model) without writing anything. */
export async function testConnection(cfg, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (!fetchImpl) throw new ProviderError('This browser cannot make network requests', { code: 'network' });
  requireModel(cfg);
  const started = Date.now();
  if (cfg.provider === 'gemini') {
    if (!cfg.apiKey) {
      throw new ProviderError('A Gemini API key is needed', {
        code: 'auth', hint: 'Create one at https://aistudio.google.com/apikey, then paste it here.',
      });
    }
    const base = trimBase(cfg.baseUrl, PROVIDERS.gemini.baseUrl);
    const data = await request(`${base}/models/${encodeURIComponent(cfg.model)}?key=${encodeURIComponent(cfg.apiKey)}`, { method: 'GET' }, {
      signal, fetchImpl, provider: cfg.provider, timeoutMs: 20000,
    });
    return {
      ok: true, provider: cfg.provider, model: cfg.model, detail: data.displayName || cfg.model,
      ms: Date.now() - started,
    };
  }
  const base = trimBase(cfg.baseUrl, PROVIDERS.openai.baseUrl);
  const data = await request(`${base}/models`, { method: 'GET', headers: auth(cfg.apiKey) }, {
    signal, fetchImpl, provider: cfg.provider, timeoutMs: 20000,
  });
  const ids = modelIds(data);
  return {
    ok: true, provider: cfg.provider, model: cfg.model,
    detail: ids.length ? `${ids.length} model${ids.length === 1 ? '' : 's'} available${ids.includes(cfg.model) ? '' : ` (${cfg.model} is not listed)`}` : 'the server answered',
    ms: Date.now() - started, models: ids,
  };
}

/** List model names for the picker. Throws ProviderError when the provider cannot answer. */
export async function listModels(cfg, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (!fetchImpl) throw new ProviderError('This browser cannot make network requests', { code: 'network' });
  const base = trimBase(cfg.baseUrl, PROVIDERS[cfg.provider]?.baseUrl || PROVIDERS.openai.baseUrl);
  if (cfg.provider === 'gemini') {
    if (!cfg.apiKey) throw new ProviderError('A Gemini API key is needed', { code: 'auth', hint: 'Add a key first.' });
    const data = await request(`${base}/models?pageSize=100&key=${encodeURIComponent(cfg.apiKey)}`, { method: 'GET' }, {
      signal, fetchImpl, provider: cfg.provider, timeoutMs: 20000,
    });
    return [...new Set((data.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean))];
  }
  const data = await request(`${base}/models`, { method: 'GET', headers: auth(cfg.apiKey) }, {
    signal, fetchImpl, provider: cfg.provider, timeoutMs: 20000,
  });
  return modelIds(data);
}

export const providerConfig = ({ provider = 'gemini', model, baseUrl, apiKey } = {}) => ({
  provider,
  model: String(model || PROVIDERS[provider]?.model || '').trim(),
  baseUrl: String(baseUrl || PROVIDERS[provider]?.baseUrl || '').trim(),
  apiKey: String(apiKey || ''),
});
