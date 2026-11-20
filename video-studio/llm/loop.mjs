// A provider-neutral tool loop: give the model the toolkit, run what it asks for, feed the
// result back, repeat. This is what replaces `claude -p` for Gemini, GPT and local models.
import { extractJson } from './json.mjs';

const HISTORY_OUTPUT = 12_000;

export const TEXT_TOOL_PROTOCOL = `## Tools

You work by calling tools. End your reply with exactly one block, and nothing after it:

\`\`\`tool
{"name": "bash", "arguments": {"command": "ls"}}
\`\`\`

Tool names and arguments:
- bash: {"command": "...", "cwd": "optional", "timeout": 900}
- read_file: {"path": "...", "offset": 1, "limit": 1500}
- write_file: {"path": "...", "content": "..."}
- edit_file: {"path": "...", "old_text": "...", "new_text": "..."}
- list_files: {"pattern": "**/*.js", "path": "optional"}
- grep: {"pattern": "regex", "path": "optional", "ignore_case": false}

When the whole job is finished, end your reply with:
DONE: one short sentence saying what you built.

Never invent tool output. Use the result you are given.`;

/** Pull tool calls out of a chat reply: ```tool blocks, <tool_call> tags, or bare JSON with name/arguments. */
export function parseTextToolCalls(text) {
  const calls = [];
  const src = String(text ?? '');
  const add = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const name = obj.name || obj.tool || obj.tool_name;
    if (!name || !/^[a-z_]+$/i.test(name)) return;
    let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { try { args = extractJson(args); } catch { args = {}; } } }
    calls.push({ id: `text_${calls.length}`, name: String(name), args: args && typeof args === 'object' ? args : {}, argumentsText: JSON.stringify(args ?? {}), error: null });
  };
  const fence = /```(?:tool|tool_call|json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(src))) {
    const body = m[1].trim();
    if (!/["']?\b(name|tool|tool_name)\b["']?\s*:/.test(body)) continue;
    try { add(extractJson(body)); } catch { /* not a tool block */ }
  }
  const tag = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  while ((m = tag.exec(src))) { try { add(extractJson(m[1])); } catch { /* ignore */ } }
  // some models just answer with the JSON object
  if (!calls.length) {
    const trimmed = src.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    if (/^\{[\s\S]*\}$/.test(trimmed)) { try { add(extractJson(trimmed)); } catch { /* ignore */ } }
  }
  // de-duplicate identical calls produced by overlapping patterns
  return calls.filter((c, i) => i === calls.findIndex((d) => d.name === c.name && JSON.stringify(d.args) === JSON.stringify(c.args)));
}

const clip = (s, n = HISTORY_OUTPUT) => (String(s).length > n ? `${String(s).slice(0, n)}\n…[output cut]` : String(s));

const sizeOf = (messages) => messages.reduce((n, m) => n + String(m.content ?? '').length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0);

/**
 * Keep a long build inside a local model's context window: drop turns from the top,
 * whole turns at a time so a tool result never loses the call it belongs to.
 */
export function trimHistory(messages, budget = 40000, { keepTail = 8 } = {}) {
  if (!budget || budget <= 0 || sizeOf(messages) <= budget) return { messages, trimmed: 0 };
  const out = messages.slice();
  let trimmed = 0;
  while (sizeOf(out) > budget && out.length > keepTail + 1) {
    let k = 2;
    while (k < out.length && out[k].role === 'tool') k++;
    if (k >= out.length) break;
    out.splice(1, k - 1);
    trimmed++;
  }
  if (trimmed) out.splice(1, 0, { role: 'user', content: `[${trimmed} earlier build steps were trimmed to fit the model's context window. Continue from the most recent tool result.]` });
  return { messages: out, trimmed };
}

export function buildTextTask(task) {
  return `${task}\n\n${TEXT_TOOL_PROTOCOL}`;
}

/**
 * @returns {Promise<{text:string, steps:number, stopped:string, messages:Array}>}
 */
export async function runToolLoop({
  client, system, task, toolkit, maxSteps = 160, temperature, signal,
  onAssistant, onTool, toolMode = 'auto', textProtocol = false, historyChars = 160000, shouldContinue,
}) {
  const useText = toolMode === 'text' || textProtocol;
  const messages = [{ role: 'user', content: useText ? buildTextTask(task) : task }];
  const seen = new Map();
  let nudges = 0;
  let lastText = '';

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return { text: lastText, steps: step - 1, stopped: 'aborted', messages };
    const history = trimHistory(messages, historyChars).messages;
    const res = await client.chat({
      system,
      messages: history,
      tools: useText ? null : toolkit.defs,
      temperature,
      signal,
      toolMode: useText ? 'none' : 'native',
    });
    lastText = res.text || lastText;
    onAssistant?.(res, step);

    let calls = res.toolCalls || [];
    if (!calls.length && res.text) calls = parseTextToolCalls(res.text);
    if (!calls.length) {
      const doneMarker = /^\s*DONE:/im.test(res.text || '');
      let unfinished = false;
      if (!doneMarker && nudges < 3 && shouldContinue) {
        try { unfinished = await shouldContinue(); } catch { unfinished = false; }
      }
      if (useText && (unfinished || (!doneMarker && nudges < 2))) {
        // the model may have stopped to chat; ask whether it is really done
        nudges++;
        messages.push({ role: 'assistant', content: res.text || '' });
        messages.push({ role: 'user', content: 'Continue the build: call the next tool. If the video is completely finished, reply with "DONE: <what you built>".' });
        continue;
      }
      if (!useText && unfinished) {
        nudges++;
        messages.push({ role: 'assistant', content: res.text || '' });
        messages.push({ role: 'user', content: 'The project is not finished yet: there is no final.mp4 marked done. Continue with the next tool call (render, check, register the clip, stitch), then call vs.mjs done.' });
        continue;
      }
      return { text: res.text || '', steps: step, stopped: 'done', messages };
    }

    messages.push({ role: 'assistant', content: res.text || '', toolCalls: calls });
    let repeated = 0;
    for (const call of calls) {
      if (signal?.aborted) return { text: lastText, steps: step, stopped: 'aborted', messages };
      const key = `${call.name}:${JSON.stringify(call.args)}`;
      const times = (seen.get(key) || 0) + 1;
      seen.set(key, times);
      if (times >= 3) repeated++;

      let result;
      if (call.error) result = { ok: false, output: `could not read the tool arguments: ${call.error}` };
      else if (call.args?.__unparsed) result = { ok: false, output: 'tool arguments were not valid JSON' };
      else result = await toolkit.run(call.name, call.args);

      onTool?.({ call, result, step });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `${result.ok ? 'ok' : 'error'}: ${clip(result.output)}`,
      });
    }
    if (repeated) {
      messages.push({ role: 'user', content: 'That exact tool call has now run three times. Read its output, try a different command, or finish with DONE: if the video is ready.' });
    }
  }
  return { text: lastText, steps: maxSteps, stopped: 'max-steps', messages };
}
