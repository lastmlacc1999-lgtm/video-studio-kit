// Google Gemini via the Generative Language API (generateContent + function calling).
// Native rather than the OpenAI-compatibility shim, so tool calling and response schemas
// behave the same way the Gemini SDKs expect.
import { toGeminiSchema } from './json.mjs';
import { getJson, LlmError, postJson } from './http.mjs';
import { proxyFetch } from './net.mjs';

const cleanModel = (m) => String(m || '').replace(/^models\//, '').trim();

function toContents(system, messages) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      // Gemini pairs every functionCall with a functionResponse in the next user turn
      push('user', [{ functionResponse: { name: m.name || m.toolName || 'tool', response: { result: String(m.content ?? '') } } }]);
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of m.toolCalls || []) parts.push({ functionCall: { name: tc.name, args: tc.args ?? {} } });
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
    const body = { contents: toContents(system, messages) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const generationConfig = {};
    if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
    if (Number.isFinite(maxTokens)) generationConfig.maxOutputTokens = maxTokens;
    if (jsonSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = toGeminiSchema(jsonSchema);
    }
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (tools?.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const { json } = await postJson(endpoint, body, { headers, timeoutMs, signal, fetchImpl, provider: providerLabel });
    const blocked = json.promptFeedback?.blockReason;
    if (blocked) throw new LlmError(`${providerLabel} refused the prompt (${blocked})`, { provider: providerLabel, hint: 'Rephrase the idea; Gemini blocks some requests by policy.' });
    const candidate = json.candidates?.[0];
    if (!candidate) throw new LlmError(`${providerLabel} returned no candidates`, { provider: providerLabel, body: JSON.stringify(json).slice(0, 500) });
    const parts = candidate.content?.parts || [];
    let textOut = '';
    const toolCalls = [];
    for (const part of parts) {
      if (typeof part.text === 'string') textOut += part.text;
      if (part.functionCall?.name) {
        toolCalls.push({
          id: `gemini_${toolCalls.length}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
          argumentsText: JSON.stringify(part.functionCall.args || {}),
          error: null,
        });
      }
    }
    if (candidate.finishReason && ['SAFETY', 'RECITATION', 'BLOCKLIST'].includes(candidate.finishReason) && !textOut && !toolCalls.length) {
      throw new LlmError(`${providerLabel} stopped (${candidate.finishReason})`, { provider: providerLabel, hint: 'Soften the idea or try another model.' });
    }
    return { text: textOut.trim(), toolCalls, raw: json, finishReason: candidate.finishReason || '', mode: tools?.length ? 'native' : 'text' };
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
