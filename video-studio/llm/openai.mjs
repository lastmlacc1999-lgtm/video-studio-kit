// OpenAI-compatible chat client. Works with api.openai.com, OpenRouter, Groq, vLLM and —
// importantly — llama.cpp, Ollama and LM Studio, which all speak this protocol.
import { extractJson } from './json.mjs';
import { getJson, LlmError, postJson } from './http.mjs';
import { proxyFetch } from './net.mjs';

function parseArguments(value) {
  if (value === undefined || value === null || value === '') return { args: {}, error: null };
  if (typeof value === 'object') return { args: value, error: null };
  const text = String(value).trim();
  try { return { args: JSON.parse(text), error: null }; }
  catch {
    try { return { args: extractJson(text), error: null }; }
    catch { return { args: {}, error: `tool arguments were not valid JSON: ${text.slice(0, 200)}` }; }
  }
}

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') {
      const msg = { role: 'tool', tool_call_id: m.toolCallId || 'call_0', content: String(m.content ?? '') };
      if (m.name) msg.name = m.name;
      out.push(msg);
      continue;
    }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.content = m.content || null;
        msg.tool_calls = m.toolCalls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: typeof tc.argumentsText === 'string' ? tc.argumentsText : JSON.stringify(tc.args ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }
    out.push({ role: m.role === 'system' ? 'system' : 'user', content: String(m.content ?? '') });
  }
  return out;
}

export function openaiClient({
  baseUrl, apiKey = '', model, timeoutMs = 900000, providerLabel = 'model',
  fetchImpl = proxyFetch(), extraHeaders = {}, apiKeyHeader = 'Authorization',
} = {}) {
  if (!baseUrl) throw new LlmError(`${providerLabel}: no base URL`, { provider: providerLabel, hint: 'Set Base URL in Model settings.' });
  const root = String(baseUrl).replace(/\/+$/, '');
  const endpoint = /\/chat\/completions$/.test(root) ? root : `${root}/chat/completions`;
  const modelsEndpoint = `${root.replace(/\/chat\/completions$/, '')}/models`;
  const headers = { ...extraHeaders };
  if (apiKey) {
    if (apiKeyHeader.toLowerCase() === 'authorization') headers.Authorization = `Bearer ${apiKey}`;
    else headers[apiKeyHeader] = apiKey;
  }
  // remembered per endpoint so a model server that rejects a feature is only probed once
  let jsonSupport = 'schema'; // schema → object → none
  let nativeTools = true;
  let allowTemperature = true; // some reasoning models reject any temperature

  async function once({ system, messages, tools, jsonSchema, temperature, maxTokens, signal, useTools, jsonMode }) {
    const body = {
      model,
      messages: toOpenAIMessages(system, messages),
      stream: false,
    };
    if (allowTemperature && Number.isFinite(temperature)) body.temperature = temperature;
    if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
    if (useTools && tools?.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    if (jsonSchema && jsonMode !== 'none') {
      body.response_format = jsonMode === 'schema'
        ? { type: 'json_schema', json_schema: { name: 'video_script', strict: true, schema: jsonSchema } }
        : { type: 'json_object' };
    }
    const { json } = await postJson(endpoint, body, { headers, timeoutMs, signal, fetchImpl, provider: providerLabel });
    const choice = json.choices?.[0] || {};
    const msg = choice.message || {};
    let content = msg.content;
    if (Array.isArray(content)) content = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
    if (content === undefined || content === null) content = '';

    const calls = [];
    for (const [i, tc] of (msg.tool_calls || []).entries()) {
      const fn = tc.function || tc;
      const parsed = parseArguments(fn.arguments ?? fn.args);
      calls.push({
        id: tc.id || `call_${i}`,
        name: fn.name,
        args: parsed.args,
        argumentsText: typeof (fn.arguments ?? fn.args) === 'string' ? (fn.arguments ?? fn.args) : JSON.stringify(parsed.args),
        error: parsed.error,
      });
    }
    // legacy single function_call
    if (!calls.length && msg.function_call?.name) {
      const parsed = parseArguments(msg.function_call.arguments);
      calls.push({ id: 'call_0', name: msg.function_call.name, args: parsed.args, argumentsText: msg.function_call.arguments || '{}', error: parsed.error });
    }
    return { text: String(content).trim(), toolCalls: calls, raw: json, finishReason: choice.finish_reason || '' };
  }

  async function chat({
    system, messages, tools = null, jsonSchema = null, temperature, maxTokens, signal, toolMode = 'auto',
  }) {
    let jsonMode = jsonSchema ? jsonSupport : 'none';
    let lastErr;

    // if a server does not know tools or response_format, fall back instead of failing the job
    for (let attempt = 0; attempt < 4; attempt++) {
      const mode = toolMode === 'text' ? 'none' : toolMode === 'native' ? 'native' : nativeTools ? 'native' : 'none';
      const useTools = !!tools?.length && mode === 'native';
      try {
        const res = await once({ system, messages, tools, jsonSchema, temperature, maxTokens, signal, useTools, jsonMode });
        if (jsonSchema && jsonMode === 'schema') jsonSupport = 'schema';
        if (jsonSchema && jsonMode === 'object') jsonSupport = 'object';
        if (jsonSchema && jsonMode === 'none') jsonSupport = 'none';
        return { ...res, mode: useTools ? 'native' : 'text', jsonMode };
      } catch (e) {
        lastErr = e;
        if (!(e instanceof LlmError) || !e.status) throw e;
        const mention = `${e.message} ${e.body || ''}`;
        const rejectsTools = useTools && /tool|function|tool_choice/i.test(mention);
        const rejectsJson = jsonSchema && jsonMode !== 'none' && /response_format|json_schema|json_object|format/i.test(mention);
        const rejectsTemperature = allowTemperature && Number.isFinite(temperature) && /temperature/i.test(mention);
        if (e.status === 400 || e.status === 404 || e.status === 422 || e.status === 500) {
          if (rejectsTemperature) { allowTemperature = false; continue; }
          if (rejectsTools) { nativeTools = false; continue; }
          if (rejectsJson) { jsonMode = jsonMode === 'schema' ? 'object' : 'none'; continue; }
          if (useTools && (e.status === 404 || e.status === 422)) { nativeTools = false; continue; }
        }
        throw e;
      }
    }
    throw lastErr;
  }

  async function listModels() {
    const json = await getJson(modelsEndpoint, { headers, timeoutMs: 8000, fetchImpl });
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  }

  return {
    kind: 'openai',
    protocol: 'openai',
    model,
    endpoint,
    label: providerLabel,
    chat,
    listModels,
    async ready() { return !!(await listModels().catch(() => null)); },
  };
}
