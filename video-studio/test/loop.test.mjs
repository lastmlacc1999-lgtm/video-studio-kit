import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop, parseTextToolCalls, buildTextTask, trimHistory } from '../llm/loop.mjs';

const fakeToolkit = (calls) => ({
  defs: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }],
  async run(name, args) { calls.push({ name, args }); return { ok: true, output: `ran ${name}` }; },
});

const scripted = (replies) => {
  let i = 0;
  return {
    calls: 0,
    async chat(opts) {
      this.calls++;
      this.last = opts;
      const r = replies[Math.min(i++, replies.length - 1)];
      return { text: r.text || '', toolCalls: r.toolCalls || [], mode: 'native' };
    },
  };
};

test('runs tool calls and feeds the results back until the model stops', async () => {
  const calls = [];
  const client = scripted([
    { toolCalls: [{ id: 'a', name: 'bash', args: { command: 'echo hi' } }], text: 'running' },
    { text: 'all done' },
  ]);
  const seen = [];
  const res = await runToolLoop({ client, system: 's', task: 'do it', toolkit: fakeToolkit(calls), onTool: (e) => seen.push(e) });
  assert.equal(res.stopped, 'done');
  assert.equal(res.text, 'all done');
  assert.deepEqual(calls, [{ name: 'bash', args: { command: 'echo hi' } }]);
  assert.equal(seen.length, 1);
  assert.equal(client.calls, 2);
  assert.equal(client.last.tools.length, 1);
  // the tool result is in the history for the next turn
  const toolMsg = client.last.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /^ok: ran bash/);
});

test('an invalid tool call becomes an error result instead of crashing', async () => {
  const calls = [];
  const client = scripted([
    { toolCalls: [{ id: 'a', name: 'bash', args: {}, error: 'bad json' }] },
    { text: 'recovered' },
  ]);
  const res = await runToolLoop({ client, system: 's', task: 'x', toolkit: fakeToolkit(calls) });
  assert.equal(res.stopped, 'done');
  assert.equal(calls.length, 0);
  const toolMsg = client.last.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /error: could not read the tool arguments/);
});

test('stops at maxSteps and says so', async () => {
  const client = scripted([{ toolCalls: [{ id: 'a', name: 'bash', args: { command: 'x' } }] }]);
  const res = await runToolLoop({ client, system: 's', task: 'x', toolkit: fakeToolkit([]), maxSteps: 3 });
  assert.equal(res.stopped, 'max-steps');
  assert.equal(res.steps, 3);
});

test('an abort signal stops the loop', async () => {
  const controller = new AbortController();
  const client = scripted([{ toolCalls: [{ id: 'a', name: 'bash', args: { command: 'x' } }] }]);
  const toolkit = {
    defs: [],
    async run() { controller.abort(); return { ok: true, output: '' }; },
  };
  const res = await runToolLoop({ client, system: 's', task: 'x', toolkit, signal: controller.signal, maxSteps: 10 });
  assert.equal(res.stopped, 'aborted');
});

test('parses tool blocks, <tool_call> tags and bare JSON', () => {
  const a = parseTextToolCalls('Let me look.\n```tool\n{"name":"bash","arguments":{"command":"ls"}}\n```');
  assert.equal(a.length, 1);
  assert.equal(a[0].name, 'bash');
  assert.equal(a[0].args.command, 'ls');

  const b = parseTextToolCalls('<tool_call>{"tool":"read_file","args":{"path":"x.js"}}</tool_call>');
  assert.equal(b[0].name, 'read_file');
  assert.equal(b[0].args.path, 'x.js');

  const c = parseTextToolCalls('{"name":"grep","arguments":{"pattern":"foo"}}');
  assert.equal(c[0].name, 'grep');

  assert.deepEqual(parseTextToolCalls('I think this is fine.'), []);
});

test('the text protocol path asks for a tool block and handles DONE', async () => {
  const calls = [];
  const client = scripted([
    { text: '```tool\n{"name":"bash","arguments":{"command":"ffmpeg -version"}}\n```' },
    { text: 'DONE: made the video' },
  ]);
  const res = await runToolLoop({ client, system: 's', task: 'build', toolkit: fakeToolkit(calls), toolMode: 'text' });
  assert.equal(res.stopped, 'done');
  assert.equal(calls.length, 1);
  assert.equal(client.last.tools, null);
  assert.match(client.last.messages[0].content, /## Tools/);
});

test('the text protocol nudges a chatty model to continue', async () => {
  const calls = [];
  const client = scripted([
    { text: 'I will now start rendering the first scene.' },
    { text: '```tool\n{"name":"bash","arguments":{"command":"render"}}\n```' },
    { text: 'DONE: all scenes rendered' },
  ]);
  const res = await runToolLoop({ client, system: 's', task: 'build', toolkit: fakeToolkit(calls), toolMode: 'text' });
  assert.equal(res.stopped, 'done');
  assert.equal(calls.length, 1);
  assert.match(buildTextTask('build'), /DONE:/);
});

test('trimHistory keeps the task and never orphans a tool result', () => {
  const messages = [{ role: 'user', content: 'the task' }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'assistant', content: 'step', toolCalls: [{ id: `c${i}`, name: 'bash', args: { command: 'x'.repeat(500) } }] });
    messages.push({ role: 'tool', toolCallId: `c${i}`, name: 'bash', content: 'y'.repeat(1000) });
  }
  const { messages: out, trimmed } = trimHistory(messages, 6000, { keepTail: 6 });
  assert.ok(trimmed > 0);
  assert.equal(out[0].content, 'the task');
  assert.match(out[1].content, /earlier build steps were trimmed/);
  // every tool message still follows the assistant turn that called it
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === 'tool') assert.equal(out[i - 1]?.role === 'tool' || out[i - 1]?.toolCalls?.length > 0, true);
  }
  assert.ok(out.length < messages.length);
});

test('nudges a native-tool model that stops before the project is done', async () => {
  const calls = [];
  let finished = false;
  const client = scripted([
    { text: 'I think that is enough for now.' },
    { toolCalls: [{ id: 'a', name: 'bash', args: { command: 'finish' } }] },
    { text: 'Done.' },
  ]);
  const res = await runToolLoop({
    client, system: 's', task: 'build', toolkit: fakeToolkit(calls), maxSteps: 8,
    shouldContinue: () => !finished,
  });
  assert.equal(res.stopped, 'done');
  assert.equal(calls.length, 1);
  assert.match(client.last.messages.find((m) => m.role === 'user' && /not finished yet/.test(m.content)).content, /final\.mp4/);
});
