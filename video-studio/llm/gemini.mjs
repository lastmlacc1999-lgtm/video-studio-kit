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
export const GEMINI_SIGNATURE_FIX = 2;
const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const signatureOf = (part) => {
  const sig = part?.thoughtSignature ?? part?.thought_signature;
  return typeof sig === 'string' && sig ? sig : '';
};
const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

// Gemini returns a thought signature beside a functionCall and validates it again on the
// next request. Keeping the raw model parts is safer than rebuilding them: it preserves
// signatures, thought parts and the original order exactly. `signAll` is the repair mode
// used only after Gemini rejects a request; it fills every unsigned functionCall with the
// documented dummy so a stricter model cannot reject the second/third call in a batch.
function toContents(system, messages, { signAll = false } = {}) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const signed = (part) => {
    if (!signAll || !part?.functionCall || signatureOf(part)) return part;
    part.thoughtSignature = DUMMY_THOUGHT_SIGNATURE;
    return part;
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
        push('model', m.nativeParts.map((p) => signed(clone(p))));
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
      // Old history, another provider, or a hand-built call has no signature. Gemini 3
      // rejects the whole request in that case; the documented dummy skips validation.
      if (signAll) for (const part of parts) signed(part);
      else if (firstCall >= 0 && !signedCall) parts[firstCall].thoughtSignature = DUMMY_THOUGHT_SIGNATURE;
      push('model', parts);
      continue;
    }
    if (m.content) push('user', [{ text: String(m.content) }]);
  }
  return contents;
}

export function geminiClient({
  baseUrl = 'https://generativelanguage.googleapis.com', apiKey, model,
  timeoutMs = 900000, providerLabel = 'Gemini', fetchImpl = proxyFetch(),
} = {}) {
  if (!apiKey) throw new LlmError(`${providerLabel}: no API key`, { provider: providerLabel, hint: 'Add a Gemini API key in Model settings, or set GEMINI_API_KEY.' });
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const apiRoot = /\/v1(beta)?\d*$/.test(root) ? root : `${root}/v1beta`;
  const name = cleanModel(model);
  if (!name) throw new LlmError(`${providerLabel}: no model name`, { provider: providerLabel, hint: 'Use e.g. gemini-2.5-flash or gemini-2.5-pro.' });
  const endpoint = `${apiRoot}/models/${encodeURIComponent(name)}:generateContent`;
  const headers = { 'x-goog-api-key': apiKey };

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
    const send = (signAll) => postJson(
      endpoint,
      { ...base, contents: toContents(system, messages, { signAll }) },
      { headers, timeoutMs, signal, fetchImpl, provider: providerLabel },
    );
    const isSignatureError = (e) => e?.status === 400 && /thought[_ ]?signature/i.test(`${e.body || ''} ${e.message || ''}`);

    let json;
    try {
      ({ json } = await send(false));
    } catch (e) {
      // Some Gemini 3.x models validate every functionCall part, not just the first one
      // in a parallel batch. Retry once with the documented dummy on every unsigned call.
      if (!isSignatureError(e)) throw e;
      console.warn(`[${providerLabel}] thought_signature rejected; retrying with repaired history`);
      ({ json } = await send(true));
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
