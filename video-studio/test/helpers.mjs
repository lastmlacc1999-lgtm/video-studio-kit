// Shared test helpers: a tiny HTTP server to act as an OpenAI/Gemini/llama.cpp endpoint,
// and temp folders that keep the real config and projects untouched.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function mockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(rec);
      let out;
      try { out = await handler(rec, requests); }
      catch (e) { out = { status: 500, json: { error: { message: String(e) } } }; }
      if (out === undefined) out = { status: 404, json: { error: { message: 'not found' } } };
      const status = out.status ?? 200;
      const payload = out.raw !== undefined ? out.raw : JSON.stringify(out.json ?? {});
      res.writeHead(status, { 'Content-Type': out.type || 'application/json' });
      res.end(payload);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

export function tempDir(prefix = 'vs-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function chatResponse({ content = '', toolCalls = [], finish = 'stop' } = {}) {
  const message = { role: 'assistant', content };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((t, i) => ({
      id: t.id || `call_${i}`,
      type: 'function',
      function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments ?? {}) },
    }));
  }
  return { id: 'chatcmpl-test', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }] };
}

export function geminiResponse({ text = '', functionCalls = [], finishReason = 'STOP', textSignature = '', thought = '' } = {}) {
  const parts = [];
  if (thought) parts.push({ text: thought, thought: true });
  if (text || textSignature) {
    const textPart = { text };
    if (textSignature) textPart.thoughtSignature = textSignature;
    parts.push(textPart);
  }
  for (const f of functionCalls) {
    const callPart = { functionCall: { name: f.name, args: f.args || {} } };
    if (f.thoughtSignature) callPart.thoughtSignature = f.thoughtSignature;
    parts.push(callPart);
  }
  return { candidates: [{ content: { role: 'model', parts }, finishReason }] };
}
