// Google Gemini via the Generative Language API (generateContent + function calling).
// Native rather than the OpenAI-compatibility shim, so tool calling and response schemas
// behave the same way the Gemini SDKs expect.
import { toGeminiSchema } from './json.mjs';
import { getJson, LlmError, postJson } from './http.mjs';
import { proxyFetch } from './net.mjs';

const cleanModel = (m) => String(m || '').replace(/^models\//, '').trim();

// Gemini 3 (and newer) validate thought signatures on function-call parts. The signature is
// a field of the part next to functionCall, not inside functionCall. Keep it verbatim.
// Docs: https://ai.google.dev/gemini-api/docs/thought-signatures
// Marker for the installed replay logic; the patch README asks users to search for it.
export const GEMINI_SIGNATURE_FIX = 3;
const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const signatureOf = (part) => {
  const sig = part?.thoughtSignature ?? part?.thought_signature;
  return typeof sig === 'string' && sig ? sig : '';
};
const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

// Gemini returns a thought signature beside a functionCall and validates it again on the
// next request. Keeping the raw model parts is safer than rebuilding them: it preserves
// signatures, thought parts and the original order exactly. Repair modes are used only
// after Gemini rejects a request:
//   inherit - copy the turn's real signature onto every unsigned functionCall (some Gemini
//             3.x routes require one on every parallel call, not just the first);
//   dummy   - use the documented skip_thought_signature_validator placeholder.
function toContents(system, messages, { signMode = 'exact' } = {}) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const fill = (parts, turnSig) => {
    if (signMode === 'exact') return parts;
    for (const part of parts) {
      if (!part?.functionCall || signatureOf(part)) continue;
      part.thoughtSignature = signMode === 'inherit' && turnSig ? turnSig : DUMMY_THOUGHT_SIGNATURE;
    }
    return parts;
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      // Gemini pairs every functionCall with a functionResponse in the next user turn
      push('user', [{ functionResponse: { name: m.name || m.toolName || 'tool', response: { result: String(m.content ?? '') } } }]);
      continue;
    }
    if (m.role === 'assistant') {
      // The exact parts returned by Gemini. Do not reorder or drop thought/signature parts.
      if (m.nativeParts?.length) {
        const raw = clone(m.nativeParts);
        const turnSig = raw.map(signatureOf).find(Boolean) || '';
        push('model', fill(raw, turnSig));
        continue;
      }
      const parts = [];
      const calls = m.toolCalls || [];
      const textSig = signatureOf(m);
      if (m.content || (textSig && !calls.length)) {
        const textPart = { text: String(m.content || '') };
        if (textSig) textPart.thoughtSignature = textSig;
        parts.push(textPart);
      }
      let firstCall = -1;
      let signedCall = false;
      for (const tc of calls) {
        const callPart = { functionCall: { name: tc.name, args: tc.args ?? {} } };
        const sig = signatureOf(tc);
        if (sig) { callPart.thoughtSignature = sig; signedCall = true; }
        if (firstCall < 0) firstCall = parts.length;
        parts.push(callPart);
      }
      if (signMode !== 'exact') {
        fill(parts, [textSig, ...calls.map(signatureOf)].find(Boolean) || '');
      } else if (firstCall >= 0 && !signedCall) {
        // Old history, another provider, or a hand-built call has no signature. Gemini 3
        // rejects the whole request in that case; the documented dummy skips validation.
        parts[firstCall].thoughtSignature = DUMMY_THOUGHT_SIGNATURE;
      }
      push('model', parts);
      continue;
    }
    if (m.content) push('user', [{ text: String(m.content) }]);
  }
  return contents;
}


// Gemini's free tier is rate limited per minute as well as per day (5 RPM on the Flash
// models, 15 RPM on Flash-Lite). The build loop sends a request after every tool step, so
// pace the client instead of firing them back-to-back. Paid users can set
// VS_GEMINI_MIN_INTERVAL_MS=0 (or a smaller value) to remove the delay.
export function geminiInterval(model) {
  const env = Number(process.env.VS_GEMINI_MIN_INTERVAL_MS ?? process.env.VS_LLM_MIN_INTERVAL_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return /flash[-_ ]?lite/i.test(cleanModel(model)) ? 4500 : 12500;
}

const pause = (ms, signal) => new Promise((resolve) => {
  if (!(ms > 0)) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function geminiClient({
  baseUrl = 'https://generativelanguage.googleapis.com', apiKey, model,
  timeoutMs = 900000, providerLabel = 'Gemini', fetchImpl = proxyFetch(), onLog = null,
  minIntervalMs = 0, retryDelayMs = 15000,
} = {}) {
  if (!apiKey) throw new LlmError(`${providerLabel}: no API key`, { provider: providerLabel, hint: 'Add a Gemini API key in Model settings, or set GEMINI_API_KEY.' });
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const apiRoot = /\/v1(beta)?\d*$/.test(root) ? root : `${root}/v1beta`;
  const name = cleanModel(model);
  if (!name) throw new LlmError(`${providerLabel}: no model name`, { provider: providerLabel, hint: 'Use e.g. gemini-2.5-flash or gemini-2.5-pro.' });
  const endpoint = `${apiRoot}/models/${encodeURIComponent(name)}:generateContent`;
  const headers = { 'x-goog-api-key': apiKey };
  onLog?.(`Gemini signature fix v${GEMINI_SIGNATURE_FIX} active`);
  if (minIntervalMs > 0) onLog?.(`Gemini pacing: one request every ${(minIntervalMs / 1000).toFixed(1)}s (per-minute limit guard)`);
  let nextRequestAt = 0;
  const pace = async (signal) => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await pause(wait, signal);
    nextRequestAt = Date.now() + Math.max(0, minIntervalMs);
  };

  async function chat({ system, messages, tools = null, jsonSchema = null, temperature, maxTokens, signal }) {
    const base = {};
    if (system) base.systemInstruction = { parts: [{ text: system }] };
    const generationConfig = {};
    if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
    if (Number.isFinite(maxTokens)) generationConfig.maxOutputTokens = maxTokens;
    if (jsonSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = toGeminiSchema(jsonSchema);
    }
    if (Object.keys(generationConfig).length) base.generationConfig = generationConfig;
    if (tools?.length) {
      base.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];
      base.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const isSignatureError = (e) => e?.status === 400 && /thought[_ ]?signature/i.test(`${e.body || ''} ${e.message || ''}`);
    const isDailyQuota = (e) => e?.status === 429 && /per day|daily/i.test(`${e.body || ''} ${e.message || ''}`);
    const retryAfterMs = (e) => {
      const match = /"?retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i.exec(String(e?.body || ''));
      return match ? Math.ceil(Number(match[1]) * 1000) : 0;
    };
    const send = async (signMode) => {
      let lastError;
      for (let attempt = 0; attempt <= 2; attempt++) {
        await pace(signal);
        try {
          return await postJson(
            endpoint,
            { ...base, contents: toContents(system, messages, { signMode }) },
            { headers, timeoutMs, signal, fetchImpl, provider: providerLabel, retries: 0 },
          );
        } catch (e) {
          lastError = e;
          if (isDailyQuota(e)) {
            e.hint = 'The Gemini free-tier daily request limit is used up. Wait for the midnight Pacific reset, or switch the build model/provider (Claude Code, OpenAI, or a paid Gemini tier).';
            throw e;
          }
          if (e?.status === 429 || e?.status >= 500) {
            const wait = retryAfterMs(e) || (e.status === 429 ? Math.max(minIntervalMs, retryDelayMs) : 2000 * 2 ** attempt);
            nextRequestAt = Math.max(nextRequestAt, Date.now() + wait);
            if (attempt < 2) continue;
          }
          throw e;
        }
      }
      throw lastError;
    };

    let json = null;
    try {
      ({ json } = await send('exact'));
    } catch (firstError) {
      if (!isSignatureError(firstError)) throw firstError;
      // Some Gemini 3.x routes require a signature on every functionCall part, not only
      // the first one in a parallel batch. Try the turn's real signature first, then the
      // documented dummy placeholder.
      let lastError = firstError;
      for (const signMode of ['inherit', 'dummy']) {
        const note = `[${providerLabel}] thought_signature rejected; retrying with ${signMode} signatures`;
        console.warn(note);
        onLog?.(note);
        try {
          ({ json } = await send(signMode));
          break;
        } catch (e) {
          if (!isSignatureError(e)) throw e;
          lastError = e;
        }
      }
      if (!json) throw lastError;
    }
    const blocked = json.promptFeedback?.blockReason;
    if (blocked) throw new LlmError(`${providerLabel} refused the prompt (${blocked})`, { provider: providerLabel, hint: 'Rephrase the idea; Gemini blocks some requests by policy.' });
    const candidate = json.candidates?.[0];
    if (!candidate) throw new LlmError(`${providerLabel} returned no candidates`, { provider: providerLabel, body: JSON.stringify(json).slice(0, 500) });
    const parts = candidate.content?.parts || [];
    let textOut = '';
    let lastSignature = '';
    const toolCalls = [];
    for (const part of parts) {
      const signature = signatureOf(part);
      if (signature) lastSignature = signature;
      // Thought text is not the answer, but the raw parts are kept for the next request.
      if (part.thought === true) continue;
      if (typeof part.text === 'string') textOut += part.text;
      if (part.functionCall?.name) {
        const call = {
          id: `gemini_${toolCalls.length}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
          argumentsText: JSON.stringify(part.functionCall.args || {}),
          error: null,
        };
        // Parallel calls only sign the first functionCall part; preserve that exactly.
        if (signature) call.thoughtSignature = signature;
        toolCalls.push(call);
      }
    }
    if (candidate.finishReason && ['SAFETY', 'RECITATION', 'BLOCKLIST'].includes(candidate.finishReason) && !textOut && !toolCalls.length) {
      throw new LlmError(`${providerLabel} stopped (${candidate.finishReason})`, { provider: providerLabel, hint: 'Soften the idea or try another model.' });
    }
    return {
      text: textOut.trim(),
      toolCalls,
      // Replay the exact model turn (thought parts, signatures and order) on the next call.
      nativeParts: toolCalls.length ? clone(parts) : null,
      // A response without function calls can still carry a signature on its last part.
      thoughtSignature: toolCalls.length ? '' : lastSignature,
      raw: json,
      finishReason: candidate.finishReason || '',
      mode: tools?.length ? 'native' : 'text',
    };
  }

  async function listModels() {
    const json = await getJson(`${apiRoot}/models?pageSize=100`, { headers, timeoutMs: 10000, fetchImpl });
    return (json.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => cleanModel(m.name))
      .filter((m) => !/embedding|aqa|imagen|veo|tts/i.test(m));
  }

  return {
    kind: 'gemini',
    protocol: 'gemini',
    model: name,
    endpoint,
    label: providerLabel,
    chat,
    listModels,
    async ready() { return !!(await listModels().catch(() => null)); },
  };
}
