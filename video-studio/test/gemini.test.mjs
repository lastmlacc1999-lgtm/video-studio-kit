import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiClient } from '../llm/gemini.mjs';
import { runToolLoop } from '../llm/loop.mjs';
import { TOOL_DEFS } from '../llm/tools.mjs';
import { SCENE_SCHEMA } from '../llm/json.mjs';
import { mockServer, geminiResponse } from './helpers.mjs';

test('builds a generateContent request with a system prompt, tools and a response schema', async () => {
  const server = await mockServer((req) => {
    assert.match(req.url, /\/v1beta\/models\/gemini-2\.5-pro:generateContent$/);
    assert.equal(req.headers['x-goog-api-key'], 'g-key');
    assert.equal(req.body.systemInstruction.parts[0].text, 'director');
    assert.equal(req.body.contents[0].role, 'user');
    assert.equal(req.body.contents[0].parts[0].text, 'make a video');
    assert.equal(req.body.tools[0].functionDeclarations[0].name, 'bash');
    assert.equal(req.body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
    assert.equal(req.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(req.body.generationConfig.responseSchema.type, 'OBJECT');
    return { json: geminiResponse({ text: '{"title":"ok","scenes":[]}' }) };
  });
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'g-key', model: 'models/gemini-2.5-pro' });
    const res = await client.chat({
      system: 'director',
      messages: [{ role: 'user', content: 'make a video' }],
      tools: TOOL_DEFS,
      jsonSchema: SCENE_SCHEMA,
      temperature: 0.4,
    });
    assert.equal(res.text, '{"title":"ok","scenes":[]}');
    assert.equal(client.model, 'gemini-2.5-pro');
  } finally { await server.close(); }
});

test('parses functionCall parts into tool calls', async () => {
  const server = await mockServer(() => ({ json: geminiResponse({ functionCalls: [{ name: 'bash', args: { command: 'ffmpeg -version' } }] }) }));
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'gemini-2.5-flash' });
    const res = await client.chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOL_DEFS });
    assert.equal(res.toolCalls.length, 1);
    assert.deepEqual(res.toolCalls[0].args, { command: 'ffmpeg -version' });
  } finally { await server.close(); }
});

test('converts tool results and previous calls into Gemini turns', async () => {
  const server = await mockServer((req) => {
    const contents = req.body.contents;
    assert.equal(contents[0].role, 'user');
    assert.equal(contents[1].role, 'model');
    assert.equal(contents[1].parts[0].functionCall.name, 'bash');
    assert.equal(contents[2].role, 'user');
    assert.equal(contents[2].parts[0].functionResponse.name, 'bash');
    assert.equal(contents[2].parts[0].functionResponse.response.result, 'ok: hi');
    return { json: geminiResponse({ text: 'finished' }) };
  });
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'm' });
    const res = await client.chat({
      messages: [
        { role: 'user', content: 'build' },
        { role: 'assistant', content: '', toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] },
        { role: 'tool', name: 'bash', toolCallId: 't1', content: 'ok: hi' },
      ],
      tools: TOOL_DEFS,
    });
    assert.equal(res.text, 'finished');
  } finally { await server.close(); }
});

test('round-trips thought signatures on function-call parts', async () => {
  const server = await mockServer((req, requests) => {
    if (requests.length === 1) {
      return {
        json: geminiResponse({
          functionCalls: [
            { name: 'bash', args: { command: 'echo a' }, thoughtSignature: 'sig-A' },
            { name: 'bash', args: { command: 'echo b' } },
          ],
        }),
      };
    }
    const model = req.body.contents[1];
    assert.equal(model.role, 'model');
    assert.equal(model.parts[0].functionCall.name, 'bash');
    assert.equal(model.parts[0].thoughtSignature, 'sig-A');
    assert.equal(model.parts[1].functionCall.name, 'bash');
    assert.equal('thoughtSignature' in model.parts[1], false);
    assert.equal(req.body.contents[2].role, 'user');
    assert.equal(req.body.contents[2].parts.length, 2);
    assert.equal(req.body.contents[2].parts[0].functionResponse.name, 'bash');
    assert.equal(req.body.contents[2].parts[1].functionResponse.name, 'bash');
    return { json: geminiResponse({ text: 'finished' }) };
  });
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'm' });
    const first = await client.chat({ messages: [{ role: 'user', content: 'build' }], tools: TOOL_DEFS });
    assert.equal(first.toolCalls[0].thoughtSignature, 'sig-A');
    assert.equal(first.toolCalls[1].thoughtSignature, undefined);
    assert.equal(first.thoughtSignature, '');
    const second = await client.chat({
      messages: [
        { role: 'user', content: 'build' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', name: 'bash', content: 'ok: a' },
        { role: 'tool', name: 'bash', content: 'ok: b' },
      ],
      tools: TOOL_DEFS,
    });
    assert.equal(second.text, 'finished');
  } finally { await server.close(); }
});

test('the native tool loop sends a prior call signature back with its functionCall', async () => {
  const server = await mockServer((req, requests) => {
    if (requests.length === 1) {
      return {
        json: geminiResponse({
          functionCalls: [{ name: 'bash', args: { command: 'echo a' }, thoughtSignature: 'sig-loop' }],
        }),
      };
    }
    assert.equal(req.body.contents[1].role, 'model');
    assert.equal(req.body.contents[1].parts[0].functionCall.name, 'bash');
    assert.equal(req.body.contents[1].parts[0].thoughtSignature, 'sig-loop');
    assert.equal(req.body.contents[2].parts[0].functionResponse.name, 'bash');
    return { json: geminiResponse({ text: 'DONE: built it' }) };
  });
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'm' });
    const out = await runToolLoop({
      client,
      system: 'director',
      task: 'build',
      toolkit: { defs: TOOL_DEFS, run: async () => ({ ok: true, output: 'ok' }) },
      maxSteps: 3,
    });
    assert.equal(out.stopped, 'done');
    assert.equal(out.steps, 2);
    assert.equal(server.requests.length, 2);
  } finally { await server.close(); }
});

test('uses the documented dummy signature for unsigned replayed calls', async () => {
  const server = await mockServer((req) => {
    const parts = req.body.contents[1].parts;
    assert.equal(parts[0].thoughtSignature, 'skip_thought_signature_validator');
    assert.equal(parts[0].functionCall.name, 'bash');
    assert.equal('thoughtSignature' in parts[1], false);
    return { json: geminiResponse({ text: 'ok' }) };
  });
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'm' });
    const res = await client.chat({
      messages: [
        { role: 'user', content: 'build' },
        { role: 'assistant', content: '', toolCalls: [
          { name: 'bash', args: { command: 'echo a' } },
          { name: 'bash', args: { command: 'echo b' } },
        ] },
        { role: 'tool', name: 'bash', content: 'ok: a' },
        { role: 'tool', name: 'bash', content: 'ok: b' },
      ],
      tools: TOOL_DEFS,
    });
    assert.equal(res.text, 'ok');
  } finally { await server.close(); }
});

test('skips thought text and round-trips a text-part signature', async () => {
  const server = await mockServer((req, requests) => {
    if (requests.length === 1) {
      return { json: geminiResponse({ thought: 'private reasoning', text: 'answer', textSignature: 'sig-T' }) };
    }
    const part = req.body.contents[1].parts[0];
    assert.equal(part.text, 'answer');
    assert.equal(part.thoughtSignature, 'sig-T');
    return { json: geminiResponse({ text: 'again' }) };
  });
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'm' });
    const first = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.text, 'answer');
    assert.equal(first.thoughtSignature, 'sig-T');
    assert.equal(first.toolCalls.length, 0);
    const second = await client.chat({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: first.text, thoughtSignature: first.thoughtSignature },
        { role: 'user', content: 'more' },
      ],
    });
    assert.equal(second.text, 'again');
  } finally { await server.close(); }
});

test('reports a blocked prompt clearly', async () => {
  const server = await mockServer(() => ({ json: { promptFeedback: { blockReason: 'SAFETY' } } }));
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'm' });
    await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'x' }] }), /refused the prompt \(SAFETY\)/);
  } finally { await server.close(); }
});

test('lists only text-generation models', async () => {
  const server = await mockServer((req) => {
    assert.match(req.url, /\/v1beta\/models\?pageSize=100/);
    return {
      json: {
        models: [
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/imagen-3.0', supportedGenerationMethods: ['predict'] },
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      },
    };
  });
  try {
    const client = geminiClient({ baseUrl: server.url, apiKey: 'k', model: 'm' });
    assert.deepEqual(await client.listModels(), ['gemini-2.5-pro', 'gemini-2.5-flash']);
  } finally { await server.close(); }
});

test('requires a key up front', () => {
  assert.throws(() => geminiClient({ apiKey: '', model: 'm' }), /no API key/);
});
