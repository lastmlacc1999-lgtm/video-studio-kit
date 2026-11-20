// Small HTTP helper shared by the model providers: JSON in, JSON out, clear errors, retries.
import { proxyFetch } from './net.mjs';

export class LlmError extends Error {
  constructor(message, { code = 'llm', hint = '', status = 0, body = '', provider = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.body = body;
    this.provider = provider;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timeoutSignal(ms, external) {
  const signals = [];
  if (ms > 0) signals.push(AbortSignal.timeout(ms));
  if (external) signals.push(external);
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any ? AbortSignal.any(signals) : external;
}

export function friendlyNetworkError(err, { url = '', provider = '' } = {}) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const message = String(err?.message || err);
  if (/abort/i.test(message)) {
    return new LlmError(`${provider || 'model'} request to ${host} timed out or was stopped`, { code: 'timeout', provider });
  }
  const isLocal = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/.test(host.split(':')[0] || '') || /:11434|:1234|:8080/.test(host);
  return new LlmError(
    `${provider || 'model'} cannot reach ${host || 'the server'}: ${message}`,
    {
      code: 'network',
      provider,
      hint: isLocal
        ? 'Is the local model server running? For a .gguf file, set its path in Model settings so llama-server is started for you; for Ollama (`ollama serve`) the base URL is http://127.0.0.1:11434/v1, for LM Studio http://127.0.0.1:1234/v1.'
        : 'Check the internet connection, the proxy settings, and the Base URL.',
    },
  );
}

function statusError(res, text, { provider = '' } = {}) {
  const body = String(text || '').slice(0, 1200);
  let detail = body;
  try { const j = JSON.parse(body); detail = j.error?.message || j.error || j.message || body; } catch { /* text */ }
  if (typeof detail === 'object') detail = JSON.stringify(detail);
  let hint = '';
  if (res.status === 401 || res.status === 403) hint = 'The API key was rejected. Check it in Model settings (or the environment variable).';
  else if (res.status === 404) hint = 'The model name or base URL is wrong. Use "Load models" in Model settings to see what the endpoint offers.';
  else if (res.status === 429) hint = 'Rate limited or out of quota. Wait a moment, or use a smaller/faster model for the script.';
  else if (res.status >= 500) hint = 'The provider had a server error. Try again; if it keeps failing use another model.';
  return new LlmError(`${provider || 'model'} HTTP ${res.status}: ${String(detail).slice(0, 500)}`, {
    code: res.status === 401 || res.status === 403 ? 'auth' : res.status === 404 ? 'not-found' : res.status === 429 ? 'rate-limit' : 'http',
    status: res.status, body, hint, provider,
  });
}

/**
 * POST JSON and return the parsed reply. Retries 429/5xx and network blips with backoff.
 */
export async function postJson(url, payload, {
  headers = {}, timeoutMs = 120000, signal, retries = 2, fetchImpl = proxyFetch(), provider = '',
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: timeoutSignal(timeoutMs, signal),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = friendlyNetworkError(e, { url, provider });
      // a timeout will not fix itself: don't multiply it by the retry count
      if (/abort|timeout/i.test(String(e?.name || '') + String(e?.message || ''))) throw lastErr;
      if (attempt < retries) { await sleep(700 * 2 ** attempt); continue; }
      throw lastErr;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = statusError(res, text, { provider });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = err;
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 20000) : 1000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
    const text = await res.text();
    try { return { json: JSON.parse(text), text, headers: res.headers }; }
    catch { throw new LlmError(`${provider || 'model'} returned a reply that is not JSON`, { code: 'bad-json', body: text.slice(0, 800), provider }); }
  }
  throw lastErr;
}

/** GET JSON (used for /v1/models and health probes). Returns null instead of throwing. */
export async function getJson(url, { headers = {}, timeoutMs = 4000, fetchImpl = proxyFetch(), signal } = {}) {
  const res = await fetchImpl(url, { headers, signal: timeoutSignal(timeoutMs, signal) });
  if (!res.ok) throw new LlmError(`HTTP ${res.status} from ${url}`, { status: res.status });
  return res.json();
}

export async function probe(url, { timeoutMs = 2500, headers = {}, fetchImpl = proxyFetch() } = {}) {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status };
  } catch { return { ok: false, status: 0 }; }
}
