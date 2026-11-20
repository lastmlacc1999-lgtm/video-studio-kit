// The Video Studio brain. Two backends:
//   • Claude Code headless (default) — `claude -p`, using the Claude plan’s tools.
//   • Gemini / OpenAI GPT / a local GGUF model — the provider layer in ./llm with its own
//     tool loop (bash, read/write/edit file, glob, grep), so any of them can actually build.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfig, describeConfig, backendLine } from './llm/config.mjs';
import { SCENE_SCHEMA, normalizeScript } from './llm/json.mjs';
import { SCRIPT_SYSTEM, scriptInput } from './llm/script-prompt.mjs';
import { createClient, requestJson, LlmError } from './llm/index.mjs';
import { runToolLoop } from './llm/loop.mjs';
import { createToolkit } from './llm/tools.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(ROOT, '..');
const PROJECTS = path.join(ROOT, 'projects');
const now = () => new Date().toISOString();
const pfile = (slug) => path.join(PROJECTS, slug, 'project.json');
export const load = (slug) => JSON.parse(fs.readFileSync(pfile(slug), 'utf8'));
export const save = (p) => { fs.mkdirSync(path.join(PROJECTS, p.slug), { recursive: true }); const f = pfile(p.slug), t = f + '.tmp'; p.updatedAt = now(); fs.writeFileSync(t, JSON.stringify(p, null, 2)); fs.renameSync(t, f); return p; };
const update = (slug, fn) => { const p = load(slug); fn(p); return save(p); };
const logTo = (slug, text) => update(slug, (p) => { p.log.push({ at: now(), text }); if (p.log.length > 400) p.log.splice(0, p.log.length - 400); });

const running = new Map(); // slug -> { kill() }
export const isRunning = (slug) => running.has(slug);
export const backend = () => { try { return describeConfig(resolveConfig()); } catch { return 'Claude Code'; } };

function emptyMcp() {
  const f = path.join(ROOT, '.empty-mcp.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, '{"mcpServers":{}}');
  return f;
}

function slugify(text) {
  const base = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'video';
  let slug = base, k = 2;
  while (fs.existsSync(pfile(slug))) slug = `${base}-${k++}`;
  return slug;
}

function claude(args, input, { cwd, onEvent }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TVHEAD_STUDIO: path.join(BUILD, 'studio'), HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' } });
    let buf = '', result = null, err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        try { const ev = JSON.parse(line); if (ev.type === 'result') result = ev; else onEvent?.(ev); } catch { /* not json */ }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error('could not start Claude Code: ' + e.message + '. Install it from https://claude.com/claude-code, or pick another model in Model settings.')));
    child.on('close', () => {
      if (!result && buf.trim()) { try { result = JSON.parse(buf.trim()); } catch {} }
      if (!result) return reject(new Error('Claude Code stopped without a result. ' + err.slice(-400)));
      if (result.is_error) return reject(new Error('Claude Code: ' + result.result));
      resolve(result);
    });
    child.stdin.end(input);
    resolve.child = child;
    onEvent?.({ type: '_spawned', child });
  });
}

const leanFlags = () => ['--no-session-persistence', '--strict-mcp-config', '--mcp-config', emptyMcp(), '--setting-sources', '', '--disable-slash-commands'];

function buildSystemPrompt() {
  return 'You are the video builder for Video Studio. You turn a validated scene table into real video files by calling tools: bash (shell commands, ffmpeg, node, rendering scripts), read_file, write_file, edit_file, list_files and grep. Work step by step, check what you make, and never ask the user questions — decide and build. Keep going until final.mp4 exists and the project is marked done.';
}

function catalogFacts(styles) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
    return [...styles].map((v) => {
      const [tid, sid] = String(v).split('/');
      const t = c.tools.find((x) => x.id === tid);
      const st = t?.styles.find((x) => x.id === sid);
      if (!t) return `- ${v} (not in catalog.json: use the closest available tool and say so in a note)`;
      return `- ${v} — ${st?.name || t.name}${st && st.name !== t.name ? ` (${t.name})` : ''}
  what: ${t.what}
  speed: ${t.speed || '?'}
  skill: ${path.join(BUILD, '.claude', 'skills', t.skill)}
  build: ${t.build || '(see the skill)'}
  source: ${t.repo || ''}`;
    }).join('\n');
  } catch { return '- (catalog.json could not be read; read it yourself)'; }
}

function buildTask(slug, forClaude = false) {
  const finish = `register each clip with node "${path.join(ROOT, 'vs.mjs')}" progress ${slug} "…" --scene N --clip clips/scene-NN.mp4, stitch with node "${path.join(ROOT, 'tools', 'stitch.mjs')}" ${slug}, check the result, and finish with node "${path.join(ROOT, 'vs.mjs')}" done ${slug} final.mp4. Report short progress lines with vs.mjs progress as you go. Work only inside ${path.join(PROJECTS, slug)} (copy templates from ${path.join(BUILD, 'demos')} there). Do not ask questions: decide and build.`;
  if (forClaude) {
    return `Build the Video Studio project "${slug}". The user already validated its script: the scenes in ${pfile(slug)} are the contract (tool, timing, visual, narration, on-screen text, sound, notes).
Read ${path.join(BUILD, '.claude', 'skills', 'video-studio', 'SKILL.md')} first (sections 4 "Build", "Tool notes" and "Rules") and ${path.join(ROOT, 'catalog.json')}, then build every scene, ${finish}`;
  }

  // Other models get the contract and the style facts inline: fewer tool calls, less context spent
  // re-reading a 32 KB catalog, and a clear place to start.
  let project = null;
  try { project = load(slug); } catch { /* the project file is created before buildProject runs */ }
  const scenes = project?.scenes || [];
  const styles = [...new Set(scenes.map((s) => s.tool).filter(Boolean))];
  const contract = JSON.stringify({
    title: project?.title, format: project?.format, music: project?.music,
    voice: project?.voice, style: project?.style, styleName: project?.styleName, scenes,
  }, null, 1);

  return `Build the Video Studio project "${slug}". The user already validated its script: the scene table below is the contract (tool, timing, visual, narration, on-screen text, sound, notes). Do not change the story.

## The scene table
\`\`\`json
${contract}
\`\`\`

## The style(s) to build it with
${catalogFacts(styles)}

Read ${path.join(BUILD, '.claude', 'skills', 'video-studio', 'SKILL.md')} (sections 4 "Build", "Tool notes" and "Rules") and the style's own skill before you start, then build every scene, ${finish}

Tools available to you: bash, read_file, write_file, edit_file, list_files, grep. Run commands with bash; paths like ${BUILD} are absolute, and your working folder is ${path.join(PROJECTS, slug)}.`;
}

function progressLine(cfg, call) {
  const label = cfg.label;
  if (call.name === 'bash') return `${label} · ${String(call.args?.description || call.args?.command || '').replace(/\s+/g, ' ').slice(0, 110)}`;
  if (call.name === 'write_file' || call.name === 'edit_file') return `${label} · ${call.name.replace('_', ' ')} ${path.basename(String(call.args?.path || ''))}`;
  if (call.name === 'read_file') return `${label} · read ${path.basename(String(call.args?.path || ''))}`;
  return `${label} · ${call.name}`;
}

/** Load a project and run the provider-neutral build agent. */
async function buildWithProvider(slug, cfg) {
  const controller = new AbortController();
  running.set(slug, { kill: () => controller.abort() });
  const toolkit = createToolkit({
    cwd: path.join(PROJECTS, slug),
    roots: [BUILD, path.join(PROJECTS, slug)],
    signal: controller.signal,
    log: (name, args, res) => { if (!res.ok) logTo(slug, `⚠ ${name}: ${String(res.output).split('\n')[0].slice(0, 200)}`); },
  });
  let lastLog = 0;
  try {
    const client = await createClient(cfg, 'build', { signal: controller.signal, onLog: (text) => logTo(slug, text) });
    const result = await runToolLoop({
      client,
      system: buildSystemPrompt(),
      task: buildTask(slug),
      toolkit,
      maxSteps: cfg.maxSteps,
      temperature: Number.isFinite(Number(cfg.temperature)) ? cfg.temperature : 0.4,
      signal: controller.signal,
      toolMode: cfg.toolMode,
      historyChars: cfg.provider === 'local' ? Math.max(12000, Math.floor((cfg.ctxSize || 16384) * 2.5)) : 160000,
      shouldContinue: () => { const p = load(slug); return p.status !== 'done' && !p.final; },
      onTool: ({ call }) => {
        if (Date.now() - lastLog < 1500) return;
        const line = progressLine(cfg, call);
        if (!/vs\.mjs/.test(line)) { logTo(slug, line); lastLog = Date.now(); }
      },
      onAssistant: (res) => {
        if (res.toolCalls?.length) return;
        const text = String(res.text || '').trim();
        if (text && text.length < 600 && !/```tool/.test(text)) logTo(slug, `${cfg.label}: ${text}`);
      },
    });
    if (result.stopped === 'aborted') {
      if (running.delete(slug)) update(slug, (x) => { x.status = 'script-ready'; x.log.push({ at: now(), text: 'Build stopped' }); });
      return;
    }
    running.delete(slug);
    const p = load(slug);
    if (result.stopped === 'max-steps') logTo(slug, `Stopped after the step limit (${cfg.maxSteps}). Raise max steps in Model settings, or run the build again with a stronger model.`);
    if (p.status !== 'done') update(slug, (x) => { x.status = x.final ? 'done' : 'error'; x.log.push({ at: now(), text: x.final ? 'Finished' : `${cfg.label} stopped before the final video` }); });
  } catch (e) {
    if (controller.signal.aborted) {
      if (running.delete(slug)) update(slug, (x) => { x.status = 'script-ready'; x.log.push({ at: now(), text: 'Build stopped' }); });
      return;
    }
    running.delete(slug);
    const hint = e instanceof LlmError && e.hint ? ` — ${e.hint}` : '';
    update(slug, (x) => { x.status = 'error'; x.log.push({ at: now(), text: 'Build failed: ' + e.message + hint }); });
    if (e instanceof LlmError && e.code === 'auth') logTo(slug, 'Open Model settings (⚙) in the studio to fix the API key.');
    if (e instanceof LlmError && (e.code === 'local-offline' || e.code === 'llama-server-missing' || e.code === 'gguf-missing')) logTo(slug, 'Open Model settings (⚙) in the studio to point at your GGUF file or local server.');
  } finally {
    toolkit.close();
    if (running.get(slug)?.kill) running.delete(slug);
  }
}

export async function writeScript(prompt, format = '9:16', style = null) {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const [tid, sid] = String(style || '').split('/');
  const tool = c.tools.find((t) => t.id === tid), st = tool?.styles.find((s) => s.id === sid);
  if (!st) throw new Error('Pick a style on the left first');
  const styleName = st.name === tool.name ? tool.name : `${st.name} (${tool.name})`;

  let cfg;
  try { cfg = resolveConfig(); } catch (e) { throw new Error(e.message + (e.hint ? ` — ${e.hint}` : '')); }
  const slug = slugify(prompt);

  save({
    slug, title: prompt.slice(0, 60), idea: prompt, style, styleName, format,
    voice: { engine: 'kokoro', voice: 'none', on: false }, music: 'lofi', status: 'writing-script',
    scenes: [], notes: [], llm: { provider: cfg.provider, label: cfg.label, model: cfg.scriptModel },
    log: [{ at: now(), text: `${backendLine(cfg, 'script')} is writing the script in ${styleName}…` }], final: null, createdAt: now(),
  });

  const system = SCRIPT_SYSTEM;
  const input = scriptInput({ prompt, format, styleName, style, toolWhat: tool.what });

  (async () => {
    try {
      let d;
      if (cfg.provider === 'claude') {
        const args = ['-p', '--model', cfg.scriptModel, '--output-format', 'json', '--tools', '', '--system-prompt', system, '--json-schema', JSON.stringify(SCENE_SCHEMA), ...leanFlags()];
        const r = await claude(args, input, { cwd: ROOT });
        d = r.structured_output || JSON.parse(r.result);
      } else {
        const out = await requestJson(cfg, { system, prompt: input, schema: SCENE_SCHEMA, purpose: 'script' });
        d = out.data;
      }
      const script = normalizeScript(d, { style, format });
      update(slug, (p) => {
        p.title = script.title;
        p.format = script.format;
        p.music = script.music;
        p.scenes = script.scenes.map((s) => ({ ...s, tool: style, notes: s.notes || '' }));
        p.status = 'script-ready';
        p.llm = { provider: cfg.provider, label: cfg.label, model: cfg.scriptModel };
        p.log.push({ at: now(), text: `Script ready: ${script.scenes.length} scenes. Edit anything, then validate to generate the video.` });
      });
    } catch (e) {
      const hint = e instanceof LlmError && e.hint ? ` — ${e.hint}` : e.hint ? ` — ${e.hint}` : '';
      update(slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Script failed: ' + e.message + hint }); });
    }
  })();

  return slug;
}

export function buildProject(slug) {
  if (running.has(slug)) return;
  let cfg;
  try { cfg = resolveConfig(); } catch (e) {
    update(slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Could not read Model settings: ' + e.message }); });
    return;
  }
  update(slug, (p) => {
    p.status = 'building'; p.final = null; p.savedPath = null;
    p.scenes.forEach((s) => { delete s.clip; s.status = 'pending'; });
    p.llm = { provider: cfg.provider, label: cfg.label, model: cfg.buildModel };
    p.log.push({ at: now(), text: `${describeConfig(cfg)} started building the video` });
  });

  if (cfg.provider !== 'claude') {
    buildWithProvider(slug, cfg);
    return;
  }

  const input = buildTask(slug, true);
  const args = ['-p', '--model', cfg.buildModel, '--output-format', 'stream-json', '--verbose', '--tools', 'Bash,Read,Write,Edit,Glob,Grep', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep', '--add-dir', BUILD, ...leanFlags()];
  let lastLog = 0;
  claude(args, input, {
    cwd: BUILD,
    onEvent: (ev) => {
      if (ev.type === '_spawned') { running.set(slug, { kill: () => { try { process.platform === 'win32' ? spawn('taskkill', ['/pid', String(ev.child.pid), '/T', '/F']) : ev.child.kill(); } catch {} } }); return; }
      if (ev.type !== 'assistant') return;
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_use' && Date.now() - lastLog > 1500) {
          const i = c.input ?? {};
          const what = c.name === 'Bash' ? String(i.description || i.command || '').slice(0, 110) : `${c.name.toLowerCase()} ${path.basename(String(i.file_path || i.pattern || ''))}`;
          if (!/vs\.mjs/.test(what)) { logTo(slug, 'Claude · ' + what); lastLog = Date.now(); }
        }
      }
    },
  }).then(() => {
    running.delete(slug);
    const p = load(slug);
    if (p.status !== 'done') update(slug, (x) => { x.status = x.final ? 'done' : 'error'; x.log.push({ at: now(), text: x.final ? 'Finished' : 'Claude stopped before the final video' }); });
  }).catch((e) => {
    running.delete(slug);
    const cur = load(slug);
    if (cur.status === 'building') update(slug, (p) => { p.status = 'error'; p.log.push({ at: now(), text: 'Build failed: ' + e.message }); });
  });
}

export function stopBuild(slug) {
  const handle = running.get(slug); if (!handle) return false;
  try { handle.kill(); } catch {}
  running.delete(slug);
  update(slug, (p) => { p.status = 'script-ready'; p.log.push({ at: now(), text: 'Build stopped' }); });
  return true;
}
