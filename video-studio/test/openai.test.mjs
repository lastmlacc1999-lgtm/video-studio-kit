import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiClient } from '../llm/openai.mjs';
import { TOOL_DEFS } from '../llm/tools.mjs';
import { SCENE_SCHEMA } from '../llm/json.mjs';
import { mockServer, chatResponse } from './helpers.mjs';

test('sends a chat-completions request with tools and a JSON schema, and parses tool calls', async () => {
  const server = await mockServer((req) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    assert.equal(req.body.model, 'gpt-test');
    assert.equal(req.body.stream, false);
    assert.equal(req.body.tools[0].type, 'function');
    assert.equal(req.body.tools[0].function.name, 'bash');
    assert.equal(req.body.response_format.type, 'json_schema');
    return { json: chatResponse({ toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] }) };
  });
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', apiKey: 'sk-test', model: 'gpt-test', providerLabel: 'Test GPT' });
    const res = await client.chat({
      system: 'you build videos',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_DEFS,
      jsonSchema: SCENE_SCHEMA,
    });
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].name, 'bash');
    assert.deepEqual(res.toolCalls[0].args, { command: 'echo hi' });
    assert.equal(server.requests[0].body.messages[0].role, 'system');
  } finally { await server.close(); }
});

test('falls back to plain chat when the server rejects tools', async () => {
  const server = await mockServer((req, requests) => {
    if (requests.length === 1) {
      assert.ok(req.body.tools);
      return { status: 400, json: { error: { message: 'tools are not supported by this model' } } };
    }
    assert.equal(req.body.tools, undefined);
    return { json: chatResponse({ content: 'plain answer' }) };
  });
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', model: 'small-local', providerLabel: 'Local' });
    const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOL_DEFS });
    assert.equal(server.requests.length, 2);
    assert.equal(res.text, 'plain answer');
  } finally { await server.close(); }
});

test('steps response_format down from json_schema to json_object to nothing', async () => {
  const seen = [];
  const server = await mockServer((req) => {
    const mode = req.body.response_format?.type || 'none';
    seen.push(mode);
    if (mode !== 'none') return { status: 400, json: { error: { message: 'response_format is not supported' } } };
    return { json: chatResponse({ content: '{"ok":true}' }) };
  });
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', model: 'local', providerLabel: 'Local' });
    const res = await client.chat({ messages: [{ role: 'user', content: 'x' }], jsonSchema: SCENE_SCHEMA });
    assert.deepEqual(seen, ['json_schema', 'json_object', 'none']);
    assert.equal(res.text, '{"ok":true}');
  } finally { await server.close(); }
});

test('parses legacy function_call replies', async () => {
  const server = await mockServer(() => ({
    json: { choices: [{ message: { role: 'assistant', content: '', function_call: { name: 'grep', arguments: '{"pattern":"foo"}' } } }] },
  }));
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', model: 'x', providerLabel: 'x' });
    const res = await client.chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOL_DEFS });
    assert.equal(res.toolCalls[0].name, 'grep');
    assert.deepEqual(res.toolCalls[0].args, { pattern: 'foo' });
  } finally { await server.close(); }
});

test('drops temperature when a reasoning model rejects it', async () => {
  const seen = [];
  const server = await mockServer((req) => {
    seen.push(req.body.temperature);
    if (req.body.temperature !== undefined) return { status: 400, json: { error: { message: 'Unsupported value: temperature does not support 0.6' } } };
    return { json: chatResponse({ content: 'ok' }) };
  });
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', model: 'reasoning-model', providerLabel: 'OpenAI' });
    const res = await client.chat({ messages: [{ role: 'user', content: 'x' }], temperature: 0.6 });
    assert.equal(res.text, 'ok');
    assert.deepEqual(seen, [0.6, undefined]);
  } finally { await server.close(); }
});

test('a 401 comes back as a helpful auth error', async () => {
  const server = await mockServer(() => ({ status: 401, json: { error: { message: 'Incorrect API key provided' } } }));
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', apiKey: 'bad', model: 'x', providerLabel: 'OpenAI' });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'x' }] }),
      (e) => e.code === 'auth' && /401/.test(e.message) && /API key/.test(e.hint),
    );
  } finally { await server.close(); }
});

test('lists models and tolerates the llama.cpp shape', async () => {
  const server = await mockServer((req) => {
    assert.equal(req.url, '/v1/models');
    return { json: { object: 'list', data: [{ id: 'qwen2.5-14b-instruct' }] } };
  });
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', model: 'x', providerLabel: 'Local' });
    assert.deepEqual(await client.listModels(), ['qwen2.5-14b-instruct']);
  } finally { await server.close(); }
});

test('a stopped request surfaces as a timeout error', async () => {
  const server = await mockServer(async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { json: chatResponse({ content: 'late' }) };
  });
  try {
    const client = openaiClient({ baseUrl: server.url + '/v1', model: 'x', providerLabel: 'Local', timeoutMs: 50 });
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'x' }] }),
      (e) => ['timeout', 'network'].includes(e.code),
    );
  } finally { await server.close(); }
});
