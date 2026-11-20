// The tools a video build needs: run commands, read/write/edit files, find files, grep.
// They mirror what Claude Code does for the Claude backend, but are provider-neutral and
// jailed to the folders a build may touch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const MAX_READ = 120_000;
const MAX_OUT = 24_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist', 'build', 'out', 'outputs', '.cache', '__pycache__', 'renders', 'tmp-remotion']);

export const TOOL_DEFS = [
  {
    name: 'bash',
    description: 'Run a shell command (ffmpeg, node, npm, python, the project’s own scripts). Returns stdout+stderr. Use it to render, inspect files with ffprobe, and to report progress with vs.mjs.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['command'],
      properties: {
        command: { type: 'string', description: 'the command line to run' },
        cwd: { type: 'string', description: 'working directory (relative to the project). Defaults to the project folder.' },
        timeout: { type: 'integer', description: 'seconds before the command is killed (default 900, max 3600)' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines with a header giving the total line count.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: 'first line (1-based)' },
        limit: { type: 'integer', description: 'how many lines (default 1500)' },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file. Parent folders are created automatically.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact piece of text in a file. old_text must match exactly once; include enough surrounding lines to be unique.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path', 'old_text', 'new_text'],
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
    },
  },
  {
    name: 'list_files',
    description: 'List files matching a glob pattern (supports * and **), relative to the working directory.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { pattern: { type: 'string', description: 'e.g. "**/*.js" or "src/*"' }, path: { type: 'string' } },
    },
  },
  {
    name: 'grep',
    description: 'Search text files for a regular expression. Returns path:line: text.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'folder or file to search (default: working directory)' },
        ignore_case: { type: 'boolean' },
        limit: { type: 'integer', description: 'max matches (default 80)' },
      },
    },
  },
];

export class PathJailError extends Error {}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a path and refuse anything outside the roots the build is allowed to touch. */
export function resolveInRoots(p, { cwd, roots }) {
  const raw = expandHome(String(p || ''));
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
  const allowed = roots.some((r) => isInside(path.resolve(r), abs));
  if (!allowed) {
    throw new PathJailError(`refusing to touch ${abs}: builds may only work inside ${roots.join(', ')}`);
  }
  return abs;
}

function truncate(text, { head = 14_000, tail = 8_000 } = {}) {
  const s = String(text ?? '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n…[${s.length - head - tail} characters cut]…\n${s.slice(-tail)}`;
}

function globToRegExp(pattern) {
  let p = String(pattern || '**/*').replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function walk(dir, { maxFiles = 5000 } = {}) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length > maxFiles) return out;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full); }
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

function isTextFile(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > 2_000_000) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    return !buf.subarray(0, n).includes(0);
  } catch { return false; }
}

function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* gone */ }
  }
}

export function createToolkit({ cwd, roots = [cwd], signal, env = {}, log } = {}) {
  const workdir = path.resolve(cwd);
  const allowedRoots = [...new Set(roots.map((r) => path.resolve(r)))];
  const realRoots = allowedRoots.map((r) => { try { return fs.realpathSync.native(r); } catch { return r; } });
  const children = new Set();

  if (signal) {
    signal.addEventListener('abort', () => { for (const c of children) killTree(c); children.clear(); }, { once: true });
  }

  // blocks symlinks that point out of the sandbox, not just `../` paths
  const safe = (p) => {
    const abs = resolveInRoots(p, { cwd: workdir, roots: allowedRoots });
    let probe = abs;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    try {
      const real = fs.realpathSync.native(probe);
      if (!realRoots.some((r) => isInside(r, real))) throw new PathJailError(`refusing to touch ${abs}: it resolves outside ${allowedRoots.join(', ')}`);
    } catch (e) {
      if (e instanceof PathJailError) throw e;
    }
    return abs;
  };

  // Skills live at the kit root, but models often ask for `.claude/skills/...` as a
  // relative path. Reads may fall back to any allowed root; writes/edits may not.
  const readable = (p) => {
    const abs = safe(p);
    if (fs.existsSync(abs) || path.isAbsolute(expandHome(String(p || '')))) return abs;
    for (const root of allowedRoots) {
      const candidate = path.resolve(root, String(p || ''));
      if (candidate !== abs && isInside(root, candidate) && fs.existsSync(candidate)) {
        try { return safe(candidate); } catch { /* outside a root: keep looking */ }
      }
    }
    return abs;
  };

  async function bash(args = {}) {
    const command = String(args.command || '').trim();
    if (!command) return { ok: false, output: 'no command given' };
    const runCwd = args.cwd ? safe(args.cwd) : workdir;
    if (!fs.existsSync(runCwd)) return { ok: false, output: `working directory does not exist: ${runCwd}` };
    const timeoutMs = Math.min(Math.max(Number(args.timeout) || 900, 1), 3600) * 1000;
    return await new Promise((resolve) => {
      const child = spawn(command, {
        cwd: runCwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...env, PWD: runCwd, INIT_CWD: workdir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      let out = '', err = '', finished = false;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { if (out.length < 4_000_000) out += d; });
      child.stderr.on('data', (d) => { if (err.length < 1_000_000) err += d; });
      const timer = setTimeout(() => { if (!finished) { err += `\n[timed out after ${timeoutMs / 1000}s]`; killTree(child); } }, timeoutMs);
      const done = (code, spawnError) => {
        if (finished) return;
        finished = true; clearTimeout(timer); children.delete(child);
        const ok = code === 0 && !spawnError;
        const body = [out.trim(), err.trim()].filter(Boolean).join('\n');
        resolve({ ok, code, output: truncate(body || (ok ? '(no output)' : `command failed with exit code ${code}`)) });
      };
      child.on('error', (e) => done(1, e));
      child.on('close', (code) => done(code ?? 1));
      if (signal?.aborted) killTree(child);
    });
  }

  function readFile(args = {}) {
    const file = readable(args.path);
    if (!fs.existsSync(file)) return { ok: false, output: `no such file: ${args.path}` };
    if (fs.statSync(file).isDirectory()) return { ok: false, output: `${args.path} is a folder; use list_files` };
    const content = fs.readFileSync(file, 'utf8');
    if (content.length > 4_000_000) return { ok: false, output: `file is too big (${content.length} bytes); use grep or bash` };
    const lines = content.split('\n');
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(Math.max(Number(args.limit) || 1500, 1), 8000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}→${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n');
    return { ok: true, output: truncate(`# ${path.relative(workdir, file) || file} (${lines.length} lines total${offset > 1 ? `, from line ${offset}` : ''})\n${numbered}`) };
  }

  function writeFile(args = {}) {
    const file = safe(args.path);
    if (args.content === undefined) return { ok: false, output: 'no content given' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(args.content));
    return { ok: true, output: `wrote ${Buffer.byteLength(String(args.content))} bytes to ${path.relative(workdir, file)}` };
  }

  function editFile(args = {}) {
    const file = safe(args.path);
    if (!fs.existsSync(file)) return { ok: false, output: `no such file: ${args.path}` };
    const oldText = String(args.old_text ?? '');
    if (!oldText) return { ok: false, output: 'old_text is empty' };
    const before = fs.readFileSync(file, 'utf8');
    const first = before.indexOf(oldText);
    if (first < 0) return { ok: false, output: 'old_text was not found — read the file and copy the exact text' };
    if (before.indexOf(oldText, first + 1) >= 0) return { ok: false, output: 'old_text matches in more than one place — include more surrounding lines so it is unique' };
    const after = before.slice(0, first) + String(args.new_text ?? '') + before.slice(first + oldText.length);
    fs.writeFileSync(file, after);
    return { ok: true, output: `edited ${path.relative(workdir, file)}` };
  }

  function listFiles(args = {}) {
    const base = args.path ? readable(args.path) : workdir;
    if (!fs.existsSync(base)) return { ok: false, output: `no such place: ${args.path}` };
    const pattern = args.pattern || '**/*';
    const re = globToRegExp(pattern);
    const files = fs.statSync(base).isFile() ? [base] : walk(base);
    const rel = files.map((f) => path.relative(base, f).replace(/\\/g, '/')).filter((f) => re.test(f) || re.test(path.basename(f)));
    rel.sort();
    const shown = rel.slice(0, 500);
    return { ok: true, output: truncate(shown.join('\n') + (rel.length > shown.length ? `\n…${rel.length - shown.length} more` : '') || '(no matches)') };
  }

  function grep(args = {}) {
    const pattern = String(args.pattern || '');
    if (!pattern) return { ok: false, output: 'no pattern given' };
    let re;
    try { re = new RegExp(pattern, args.ignore_case ? 'i' : ''); } catch (e) { return { ok: false, output: `bad regular expression: ${e.message}` }; }
    const base = args.path ? readable(args.path) : workdir;
    if (!fs.existsSync(base)) return { ok: false, output: `no such place: ${args.path}` };
    const files = fs.statSync(base).isFile() ? [base] : walk(base);
    const limit = Math.min(Math.max(Number(args.limit) || 80, 1), 400);
    const hits = [];
    for (const file of files) {
      if (!isTextFile(file)) continue;
      let content;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(workdir, file).replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    }
    return { ok: true, output: truncate(hits.length ? hits.join('\n') : '(no matches)') };
  }

  const handlers = { bash, read_file: readFile, write_file: writeFile, edit_file: editFile, list_files: listFiles, grep };

  return {
    defs: TOOL_DEFS,
    workdir,
    roots: allowedRoots,
    async run(name, args = {}) {
      const fn = handlers[name];
      if (!fn) return { ok: false, output: `unknown tool "${name}". Available: ${Object.keys(handlers).join(', ')}` };
      try {
        const res = await fn(args || {});
        log?.(name, args, res);
        return res;
      } catch (e) {
        const res = { ok: false, output: e instanceof PathJailError ? e.message : `${name} failed: ${e.message}` };
        log?.(name, args, res);
        return res;
      }
    },
    close() { for (const c of children) killTree(c); children.clear(); },
  };
}
