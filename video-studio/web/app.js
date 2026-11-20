// Video Studio · browser app. Writes scripts with Gemini, OpenAI GPT or a local model entirely
// in the browser, stores projects locally, and hands them to the local studio for rendering.
import { FORMATS, MUSIC, normalizeScript } from './lib/scene.js';
import { PROVIDERS, ProviderError, providerLabel, providerConfig, testConnection as testProvider, listModels, writeScript } from './lib/providers.js';
import * as store from './lib/store.js';
import * as studio from './lib/studio.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (v) => (Number.isFinite(+v) ? String(+v) : '');
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const fmtSec = (v) => (+v || 0).toFixed(1).replace(/\.0$/, '');
const list = (arr) => (arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');

const state = {
  settings: store.loadSettings(),
  catalog: null,
  styles: [],
  byId: new Map(),
  projects: [],
  current: null,
  studio: { ok: false, base: '', settings: null, error: '' },
  writing: false,
  abort: null,
  saveTimer: null,
  buildTimer: null,
  buildSlug: '',
  showBuild: false,
  filter: '',
  writeMessage: null,
  offlineSlug: '',
};

// ---------- small helpers ----------
function message(e) {
  const text = e?.message || String(e || 'Something went wrong');
  return e?.hint ? `${text}\n${e.hint}` : text;
}

let toastTimer = null;
function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'bad' ? 7000 : 3500);
}

function timeAgo(iso) {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t) || !t) return 'just now';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

function showStatus(el, text, kind = '') {
  el.textContent = text || '';
  el.className = `status ${kind}`;
  el.hidden = !text;
}

function showWriteStatus(text, kind = '') {
  state.writeMessage = text ? { text, kind } : null;
  showStatus($('#writeStatus'), text, kind);
}

function providerProfile(id = state.settings.provider) {
  return state.settings.profiles[id] || { model: '', baseUrl: '' };
}

function currentProvider() {
  const id = state.settings.provider;
  const profile = providerProfile(id);
  return providerConfig({ provider: id, model: profile.model, baseUrl: profile.baseUrl, apiKey: store.getKey(id) });
}

const studioBase = () => studio.resolveBase(state.settings.studioUrl);

// ---------- catalog & styles ----------
async function loadCatalog() {
  let catalog = null;
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined;
    const res = await fetch(`${studioBase()}/api/catalog`, { cache: 'no-store', signal });
    if (res.ok) catalog = await res.json();
  } catch { /* fall back to the static snapshot */ }
  if (!catalog) {
    try {
      const res = await fetch('./styles.json', { cache: 'no-store' });
      if (res.ok) catalog = await res.json();
    } catch { /* ignore */ }
  }
  if (!catalog) { toast('Could not load the style list.', 'bad'); return; }
  state.catalog = catalog;
  state.styles = [];
  state.byId.clear();
  for (const tool of catalog.tools || []) {
    for (const s of tool.styles || []) {
      const id = `${tool.id}/${s.id}`;
      const style = {
        id, name: s.name || tool.name, toolName: tool.name, group: tool.group,
        what: tool.what || '', speed: tool.speed || '', skill: tool.skill || '',
        example: s.example || null,
      };
      state.styles.push(style);
      state.byId.set(id, style);
    }
  }
  $('#styleSearch').placeholder = `Filter ${state.styles.length} styles…`;
  renderStyles();
  renderStyleChip();
  renderPreview();
}

function renderStyles() {
  const host = $('#styles');
  const scroll = host.scrollTop;
  if (!state.styles.length) { host.innerHTML = '<div class="style empty">Styles load with the app.</div>'; return; }
  const q = state.filter.trim().toLowerCase();
  const rows = state.styles.filter((s) => !q
    || s.name.toLowerCase().includes(q) || s.toolName.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  $('#styleCount').textContent = rows.length === state.styles.length ? '' : `${rows.length}`;
  if (!rows.length) { host.innerHTML = '<div class="style empty">No style matches that filter.</div>'; return; }
  const groupLabel = (id) => (state.catalog.groups || []).find((g) => g.id === id)?.label || 'Styles';
  const current = state.current?.style || '';
  let html = '';
  let group = null;
  for (const s of rows) {
    if (s.group !== group) {
      group = s.group;
      html += `<div class="style-group">${esc(groupLabel(group))}</div>`;
    }
    html += `<button class="style${s.id === current ? ' active' : ''}" data-style="${esc(s.id)}" title="${esc(s.what)}">`
      + `<span class="name">${esc(s.name)}</span><span class="tool">${esc(s.toolName)}</span></button>`;
  }
  host.innerHTML = html;
  host.scrollTop = scroll;
}

function renderStyleChip() {
  const p = state.current;
  const chip = $('#styleChip');
  const style = p ? state.byId.get(p.style) : null;
  chip.textContent = style ? `${style.name} · ${style.toolName}` : 'Pick a style';
  chip.classList.toggle('set', !!style);
}

function renderPreview() {
  const p = state.current;
  const style = p ? state.byId.get(p.style) : null;
  const wrap = $('#stylePreviewWrap');
  const video = $('#stylePreview');
  if (!style?.example) { wrap.hidden = true; video.removeAttribute('src'); video.load?.(); return; }
  wrap.hidden = false;
  $('#stylePreviewName').textContent = style.name;
  const url = new URL(style.example, state.studio.ok ? `${state.studio.base}/` : location.href).href;
  if (video.src !== url) {
    video.onerror = () => { wrap.hidden = true; };
    video.src = url;
    video.play?.().catch(() => {});
  }
}

function chooseStyle(id) {
  const p = state.current;
  const style = state.byId.get(id);
  if (!p || !style) return;
  const changed = p.style && p.style !== id;
  p.style = id;
  p.styleName = style.name;
  for (const scene of p.scenes) scene.tool = id;
  try { localStorage.setItem('vsb.lastStyle.v1', id); } catch { /* ignore */ }
  if (changed && p.scenes.length) toast(`Style changed to ${style.name} for every scene.`);
  renderStyles();
  renderStyleChip();
  renderPreview();
  renderValidation();
  scheduleSave();
}

// ---------- projects ----------
function blankProject() {
  const lastStyle = (() => { try { return localStorage.getItem('vsb.lastStyle.v1') || ''; } catch { return ''; } })();
  const style = state.byId.get(lastStyle);
  return {
    id: store.uid(),
    title: '', idea: '', format: '9:16', music: 'lofi',
    style: style ? style.id : '', styleName: style ? style.name : '',
    scenes: [], status: 'draft', log: [], llm: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

async function refreshProjects() {
  state.projects = await store.listProjects();
  renderProjects();
}

function renderProjects() {
  const host = $('#projects');
  $('#projectCount').textContent = state.projects.length ? `${state.projects.length}` : '';
  if (!state.projects.length) { host.innerHTML = '<div class="style empty">No videos yet — start one above.</div>'; return; }
  const current = state.current?.id;
  host.innerHTML = state.projects.map((p) => `<button class="project${p.id === current ? ' active' : ''}" data-id="${esc(p.id)}">
    <b>${esc(p.title || 'Untitled video')}</b>
    <span class="when">${esc(timeAgo(p.updatedAt))} · ${(p.scenes || []).length} scene${(p.scenes || []).length === 1 ? '' : 's'}</span>
    <span class="state ${esc(p.status || '')}" title="${esc(p.status || 'draft')}"></span>
  </button>`).join('');
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { saveNow(); }, 300);
}

async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  await store.putProject(project);
  const i = state.projects.findIndex((x) => x.id === project.id);
  if (i >= 0) state.projects[i] = project; else state.projects.unshift(project);
  renderProjects();
}

async function saveNow() {
  clearTimeout(state.saveTimer);
  if (state.current) await saveProject(state.current);
}

async function newProject() {
  await saveNow();
  if (state.abort) state.abort.abort();
  clearTimeout(state.buildTimer);
  const p = blankProject();
  state.current = p;
  state.showBuild = false;
  state.buildSlug = '';
  state.writeMessage = null;
  state.projects.unshift(p);
  store.setLastProjectId(p.id);
  await store.putProject(p);
  history.replaceState(null, '', `?p=${encodeURIComponent(p.id)}`);
  renderAll();
  $('#idea').focus();
}

async function openProject(id) {
  await saveNow();
  if (state.abort) state.abort.abort();
  clearTimeout(state.buildTimer);
  const p = await store.getProject(id);
  if (!p) return;
  state.current = p;
  state.showBuild = !!p.serverSlug;
  state.buildSlug = p.serverSlug || '';
  state.writeMessage = null;
  store.setLastProjectId(p.id);
  history.replaceState(null, '', `?p=${encodeURIComponent(p.id)}`);
  renderAll();
  if (state.studio.ok && state.buildSlug && ['building', 'build-requested'].includes(p.status)) pollBuild();
}

async function deleteCurrent() {
  const p = state.current;
  if (!p) return;
  if (!confirm(`Delete “${p.title || 'Untitled video'}”? This cannot be undone.`)) return;
  clearTimeout(state.buildTimer);
  await store.deleteProject(p.id);
  state.projects = state.projects.filter((x) => x.id !== p.id);
  state.current = null;
  store.setLastProjectId('');
  history.replaceState(null, '', location.pathname);
  renderAll();
}

function exportProject() {
  const p = state.current;
  if (!p) return;
  const data = {
    ...studio.projectShape(p),
    llm: p.llm, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${studio.slugify(p.title || p.idea || 'video')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importProject(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.', 'bad'); return; }
  if (Array.isArray(data)) data = { scenes: data };
  if (data.project && typeof data.project === 'object') data = data.project;
  const p = blankProject();
  p.title = String(data.title || data.name || 'Imported video').slice(0, 120);
  p.idea = String(data.idea || data.prompt || '');
  p.format = FORMATS.includes(data.format) ? data.format : '9:16';
  p.music = MUSIC.includes(data.music) ? data.music : 'lofi';
  const firstTool = data.scenes?.[0]?.tool;
  p.style = data.style || firstTool || '';
  p.styleName = data.styleName || state.byId.get(p.style)?.name || '';
  p.scenes = (Array.isArray(data.scenes) ? data.scenes : []).map((s, i) => ({
    n: i + 1,
    start: Number(s.start) || 0,
    end: Number(s.end) || (Number(s.start) || 0) + 3,
    tool: s.tool || p.style, visual: s.visual || '', narration: s.narration || '',
    onscreen: s.onscreen || '', sound: s.sound || '', notes: s.notes || '',
  }));
  p.status = p.scenes.length ? 'script-ready' : 'draft';
  p.llm = data.llm || null;
  p.log = Array.isArray(data.log) ? data.log : [];
  await store.putProject(p);
  await refreshProjects();
  await openProject(p.id);
  toast('Project imported');
}

// ---------- rendering the editor ----------
function renderAll() {
  const p = state.current;
  $('#empty').hidden = !!p;
  $('#editor').hidden = !p;
  if (!p) {
    renderProjects();
    renderStyles();
    renderBuild();
    return;
  }
  $('#idea').value = p.idea || '';
  $('#title').value = p.title || '';
  $('#format').value = p.format || '9:16';
  $('#music').value = p.music || 'lofi';
  $('#writeStatus').hidden = true;
  if (state.writeMessage) showWriteStatus(state.writeMessage.text, state.writeMessage.kind);
  renderProjects();
  renderStyles();
  renderStyleChip();
  renderPreview();
  renderScenes();
  renderMeta();
  renderValidation();
  renderBuild();
  renderModelPill();
}

function renderScenes() {
  const p = state.current;
  const host = $('#scenes');
  if (!p || !p.scenes.length) {
    host.innerHTML = '<div class="style empty">No scenes yet. Write a script, or add one by hand.</div>';
    return;
  }
  host.innerHTML = p.scenes.map((s, i) => {
    const dur = (+s.end || 0) - (+s.start || 0);
    return `<article class="scene" data-i="${i}">
      <header class="scene-head">
        <span class="num">#${i + 1}</span>
        <span class="dur">${fmtSec(s.start)}–${fmtSec(s.end)} s · ${fmtSec(Math.max(0, dur))} s</span>
        <button class="del" data-del="${i}" title="Delete scene" aria-label="Delete scene ${i + 1}">✕</button>
      </header>
      <div class="scene-grid">
        <label class="full">What we see<textarea data-i="${i}" data-k="visual" rows="2" placeholder="subject, action, framing">${esc(s.visual)}</textarea></label>
        <label>Narration<textarea data-i="${i}" data-k="narration" rows="2" placeholder="what the voice says (or empty)">${esc(s.narration)}</textarea></label>
        <label>On-screen text<input data-i="${i}" data-k="onscreen" value="${esc(s.onscreen)}" placeholder="none"></label>
        <label>Sound<input data-i="${i}" data-k="sound" value="${esc(s.sound)}" placeholder="wind, a click…"></label>
        <label>Notes for the builder<input data-i="${i}" data-k="notes" value="${esc(s.notes)}" placeholder="optional"></label>
        <label class="times">Time <input type="number" step="0.1" min="0" data-i="${i}" data-k="start" value="${num(s.start)}" aria-label="Scene ${i + 1} start"> <span>to</span> <input type="number" step="0.1" min="0" data-i="${i}" data-k="end" value="${num(s.end)}" aria-label="Scene ${i + 1} end"> s</label>
      </div>
    </article>`;
  }).join('');
}

function renderMeta() {
  const p = state.current;
  if (!p) return;
  const total = p.scenes.reduce((n, s) => n + Math.max(0, (+s.end || 0) - (+s.start || 0)), 0);
  $('#sceneMeta').textContent = `${p.scenes.length} scene${p.scenes.length === 1 ? '' : 's'} · ${fmtSec(total)} s`;
  $('#modelLine').textContent = p.llm ? `Script: ${p.llm.label} · ${p.llm.model}` : 'No script yet';
}

function validateProject(p) {
  const fatal = [];
  const warn = [];
  if (!p.scenes.length) return { fatal: ['No scenes yet — write a script or add one by hand.'], warn };
  let prevEnd = 0;
  p.scenes.forEach((s, i) => {
    const dur = (+s.end || 0) - (+s.start || 0);
    if (!(dur > 0.2)) fatal.push(`Scene ${i + 1}: the end must be after the start.`);
    else {
      if (dur < 1) warn.push(`Scene ${i + 1} is shorter than a second.`);
      if (dur > 10) warn.push(`Scene ${i + 1} is longer than 10 s.`);
    }
    if (!String(s.visual || '').trim()) fatal.push(`Scene ${i + 1} needs a description of what we see.`);
    if (i > 0 && Math.abs((+s.start || 0) - prevEnd) > 0.05) warn.push(`Scene ${i + 1} does not start where scene ${i} ends.`);
    prevEnd = +s.end || 0;
    const rate = words(s.narration) / (dur || 1);
    if (rate > 2.6) warn.push(`Scene ${i + 1}: narration is fast (${rate.toFixed(1)} words/s).`);
  });
  const total = p.scenes.reduce((n, s) => n + Math.max(0, (+s.end || 0) - (+s.start || 0)), 0);
  if (total < 10) warn.push(`The video is only ${fmtSec(total)} s long.`);
  if (total > 90) warn.push(`The video is ${Math.round(total)} s — long for these tools.`);
  return { fatal, warn: [...new Set(warn)] };
}

function renderValidation() {
  const p = state.current;
  if (!p) return;
  const { fatal, warn } = validateProject(p);
  const el = $('#validation');
  if (!p.scenes.length) {
    el.innerHTML = '<span class="muted">Write a script or add a scene to get started.</span>';
  } else if (fatal.length) {
    el.innerHTML = `<ul>${fatal.map((x) => `<li class="bad">${esc(x)}</li>`).join('')}${warn.map((x) => `<li class="warn">${esc(x)}</li>`).join('')}</ul>`;
  } else if (warn.length) {
    el.innerHTML = `<ul>${warn.map((x) => `<li class="warn">${esc(x)}</li>`).join('')}<li class="ok">No blocking problems.</li></ul>`;
  } else {
    el.innerHTML = '<span class="ok">Looks good — ready to render.</span>';
  }
  const btn = $('#buildBtn');
  btn.disabled = fatal.length > 0 || state.writing;
  btn.textContent = state.studio.ok ? 'Render with local tools' : 'Prepare for local render';
}

function addScene() {
  const p = state.current;
  if (!p) return;
  const last = p.scenes[p.scenes.length - 1];
  const start = last ? Number(last.end) || 0 : 0;
  p.scenes.push({
    n: p.scenes.length + 1, start, end: +(start + 3).toFixed(1), tool: p.style,
    visual: '', narration: '', onscreen: '', sound: '', notes: '',
  });
  p.status = p.status === 'done' ? 'script-ready' : p.status;
  renderScenes();
  renderMeta();
  renderValidation();
  scheduleSave();
}

// ---------- writing ----------
async function write() {
  const p = state.current;
  if (!p || state.writing) return;
  const idea = $('#idea').value.trim();
  p.idea = idea;
  if (!idea) { showWriteStatus('Describe your video first.', 'bad'); $('#idea').focus(); return; }
  const style = state.byId.get(p.style);
  if (!style) { showWriteStatus('Pick a style on the left first.', 'bad'); return; }
  let cfg;
  try {
    cfg = currentProvider();
    if (!cfg.model) throw new ProviderError('Choose a model first', { hint: 'Open ⚙ Model settings, type the model name (or press Load models) and save.' });
    if (cfg.provider === 'gemini' && !cfg.apiKey) throw new ProviderError('Add a Gemini API key first', { hint: 'Open ⚙ Model settings — keys are stored only in this browser.' });
  } catch (e) {
    showWriteStatus(message(e), 'bad');
    openSettings();
    return;
  }

  state.writing = true;
  state.abort = new AbortController();
  const started = Date.now();
  $('#writeBtn').disabled = true;
  $('#writeBtn').textContent = 'Writing…';
  showWriteStatus(`${providerLabel(cfg.provider)} · ${cfg.model} is writing the script…`, 'busy');
  renderValidation();

  try {
    const out = await writeScript(cfg, {
      prompt: idea, format: p.format, style: p.style, styleName: p.styleName || style.name,
      toolWhat: style.what, signal: state.abort.signal,
    });
    const script = normalizeScript(out.data, { style: p.style, format: p.format });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    p.title = script.title;
    p.format = script.format;
    p.music = script.music;
    p.scenes = script.scenes.map((s) => ({ ...s, tool: p.style, notes: s.notes || '' }));
    p.status = 'script-ready';
    p.llm = { provider: cfg.provider, label: providerLabel(cfg.provider), model: out.model };
    p.log = [...(p.log || []), { at: new Date().toISOString(), text: `Script ready with ${providerLabel(cfg.provider)} · ${out.model}: ${p.scenes.length} scenes in ${seconds} s.` }];
    await saveProject(p);
    if (state.current?.id === p.id) {
      renderAll();
      showWriteStatus(`Script ready: ${p.scenes.length} scenes in ${seconds} s. Edit anything, then render.`, 'ok');
    }
    toast(`Script ready: ${p.scenes.length} scenes`);
  } catch (e) {
    if (e?.code === 'aborted') {
      if (state.current?.id === p.id) showWriteStatus('Cancelled.', '');
    } else if (state.current?.id === p.id) {
      showWriteStatus(message(e), 'bad');
      if (['auth', 'config', 'network'].includes(e?.code)) toast('Open Model settings to fix this.', 'bad');
    } else {
      toast(message(e), 'bad');
    }
  } finally {
    state.writing = false;
    state.abort = null;
    $('#writeBtn').disabled = false;
    $('#writeBtn').textContent = 'Write script';
    renderValidation();
  }
}

// ---------- studio / build ----------
function renderStudioPill() {
  const el = $('#studioPill');
  if (state.studio.ok) {
    const s = state.studio.settings || {};
    el.textContent = `Local studio: connected${s.ready ? '' : ' · backend not ready'}`;
    el.className = 'pill ok';
    el.title = `${state.studio.base}\n${s.description || 'studio server'}${s.ready ? '' : `\n${s.readyDetail || 'Configure it in the studio’s ⚙ panel.'}`}`;
  } else {
    el.textContent = 'Local studio: standalone';
    el.className = 'pill off';
    el.title = `${state.studio.error || 'No studio server'} — click to set its URL. Rendering needs the local studio.`;
  }
}

function renderModelPill() {
  const cfg = currentProvider();
  $('#modelPill').textContent = `Model: ${providerLabel(cfg.provider)}${cfg.model ? ` · ${cfg.model}` : ' · not set'}`;
  const needsKey = cfg.provider !== 'local' && !cfg.apiKey;
  $('#modelPill').classList.toggle('off', !cfg.model || needsKey);
  $('#modelPill').title = needsKey ? 'No API key saved for this provider — click to add one.' : 'Model used to write scripts';
}

async function probeStudio({ quiet = false } = {}) {
  const base = studioBase();
  const res = await studio.probe(base, 2500);
  state.studio = res;
  renderStudioPill();
  if (!quiet && res.ok) toast('Local studio connected');
  return res;
}

function offlineSlugFor(p) {
  return studio.slugify(p?.title || p?.idea || 'video');
}

function renderBuild(sp = null) {
  const p = state.current;
  const panel = $('#buildPanel');
  if (!p || !state.showBuild) { panel.hidden = true; return; }
  panel.hidden = false;
  const server = state.studio.ok;
  $('#offlineActions').hidden = server;
  $('#liveBuild').hidden = !server;
  $('#buildTitle').textContent = server ? 'Local studio' : 'No studio server';
  const statusEl = $('#buildState');
  const stateText = $('#buildStateText');

  if (!server) {
    const slug = p.serverSlug || offlineSlugFor(p);
    state.offlineSlug = slug;
    $('#offlineCmd').textContent = `node video-studio/vs.mjs new ${slug} ${slug}.json\nnode video-studio/vs.mjs serve\n# open http://localhost:4790/?p=${slug} and press Build`;
    statusEl.className = 'dot';
    stateText.textContent = 'Download the project, then render with the studio on this computer.';
    $('#stopBtn').hidden = true;
    $('#revealBtn').hidden = true;
    $('#videoWrap').hidden = true;
    return;
  }

  const data = sp || {
    status: p.status, log: p.serverLog || p.log || [], final: p.final || null,
  };
  statusEl.className = `dot ${data.status || ''}`;
  const labels = {
    'build-requested': 'Waiting for the builder…',
    building: 'Rendering…',
    done: 'Video ready.',
    error: 'The build failed — see the log below.',
    'script-ready': 'Ready to render with the studio’s backend.',
  };
  stateText.textContent = labels[data.status] || 'Ready.';
  $('#stopBtn').hidden = !['building', 'build-requested'].includes(data.status);

  const log = (data.log || []).slice(-300);
  const logEl = $('#buildLog');
  logEl.textContent = log.map((l) => `${l.at ? new Date(l.at).toLocaleTimeString() + '  ' : ''}${l.text || ''}`).join('\n');
  logEl.scrollTop = logEl.scrollHeight;

  const final = data.final || (data.status === 'done' ? p.final : null);
  if (data.status === 'done' && final && state.buildSlug) {
    const url = studio.fileUrl(state.studio.base, state.buildSlug, final);
    const video = $('#finalVideo');
    if (video.src !== url) video.src = url;
    $('#videoWrap').hidden = false;
    $('#finalPath').textContent = final;
    $('#revealBtn').hidden = false;
    $('#buildTitle').textContent = 'Video ready';
  } else {
    $('#videoWrap').hidden = true;
    $('#revealBtn').hidden = true;
  }
}

async function buildAction() {
  const p = state.current;
  if (!p) return;
  const { fatal } = validateProject(p);
  if (fatal.length) { toast(fatal[0], 'bad'); renderValidation(); return; }
  if (!state.studio.ok) {
    state.showBuild = true;
    renderBuild();
    $('#buildPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const studioSettings = state.studio.settings;
  if (studioSettings && studioSettings.ready === false
    && !confirm(`The studio backend is not ready (${studioSettings.readyDetail || 'no model configured'}).\n\nConfigure it in the studio’s own ⚙ panel, or try this build anyway?`)) return;
  $('#buildBtn').disabled = true;
  try {
    const slug = await studio.importProject(state.studio.base, p, p.serverSlug || '');
    if (!p.serverSlug || p.serverSlug !== slug) {
      p.serverSlug = slug;
      p.serverLog = [];
    }
    state.buildSlug = slug;
    state.showBuild = true;
    await saveNow();
    const started = await studio.build(state.studio.base, slug);
    p.status = started.status || 'building';
    renderBuild({ status: p.status, log: started.log || [], final: null });
    renderProjects();
    toast('Build started');
    pollBuild();
  } catch (e) {
    toast(message(e), 'bad');
  } finally {
    $('#buildBtn').disabled = false;
  }
}

async function pollBuild() {
  clearTimeout(state.buildTimer);
  const projectId = state.current?.id;
  const slug = state.buildSlug;
  if (!projectId || !slug) return;
  try {
    const sp = await studio.getProject(state.studio.base, slug);
    const p = state.current;
    if (!p || p.id !== projectId) return;
    p.status = sp.status;
    p.final = sp.final;
    p.serverLog = sp.log || [];
    p.savedPath = sp.savedPath || p.savedPath;
    renderBuild(sp);
    renderProjects();
    scheduleSave();
    if (['building', 'build-requested'].includes(sp.status)) state.buildTimer = setTimeout(pollBuild, 2000);
    else if (sp.status === 'done') toast('Video ready');
  } catch (e) {
    const p = state.current;
    if (p && p.id === projectId) {
      $('#buildStateText').textContent = `Lost contact with the studio: ${e.message}`;
      $('#buildState').className = 'dot error';
    }
  }
}

function downloadProject() {
  const p = state.current;
  if (!p) return;
  const slug = state.offlineSlug || offlineSlugFor(p);
  const blob = new Blob([JSON.stringify(studio.projectShape(p), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copyOfflineCommand() {
  const text = $('#offlineCmd').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Commands copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Commands copied');
  }
}

// ---------- settings ----------
function openSettings(section = '') {
  const s = state.settings;
  const id = s.provider;
  const profile = providerProfile(id);
  const key = store.getKey(id);
  $('#setProvider').value = id;
  $('#setModel').value = profile.model || '';
  $('#setBase').value = profile.baseUrl || '';
  $('#setKey').value = key;
  $('#setKey').placeholder = key ? 'saved in this browser' : 'paste the key';
  $('#setRemember').checked = s.rememberKey !== false;
  $('#setStudio').value = s.studioUrl || '';
  $('#setStatus').hidden = true;
  $('#studioState').textContent = state.studio.ok
    ? `connected to ${state.studio.base}${state.studio.settings?.ready ? '' : ' (backend not ready)'}`
    : 'not reachable';
  updateProviderForm();
  $('#settingsModal').hidden = false;
  if (section === 'studio') { $('#setStudio').focus(); $('#setStudio').scrollIntoView({ block: 'center' }); }
}

function updateProviderForm() {
  const id = $('#setProvider').value;
  $('#setStatus').hidden = true;
  $('#setModelList').innerHTML = '';
  const p = PROVIDERS[id] || PROVIDERS.gemini;
  const profile = providerProfile(id);
  $('#setProviderHint').innerHTML = `${esc(p.hint)}${p.keyUrl ? ` <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">Get a key ↗</a>` : ''}`;
  $('#setBase').placeholder = p.baseUrl || 'https://…';
  $('#baseHint').textContent = id === 'gemini'
    ? 'Gemini uses the official endpoint; you normally do not need to change this.'
    : id === 'local'
      ? 'Where the local server listens: llama.cpp :8080, Ollama :11434, LM Studio :1234 — keep /v1.'
      : 'Only change this for an OpenAI-compatible endpoint (OpenRouter, Groq, Together, vLLM…).';
  $('#keyField').hidden = false;
  $('#baseField').hidden = id === 'gemini';
  $('#setModel').value = profile.model || p.model || '';
  $('#setBase').value = id === 'gemini' ? p.baseUrl : (profile.baseUrl || p.baseUrl);
  $('#setKey').value = store.getKey(id);
  $('#setKey').placeholder = id === 'local' ? 'optional for a local server' : 'paste the key';
  const saved = store.getKey(id);
  $('#setKeyState').textContent = id === 'local'
    ? 'Local servers usually need no key. If yours does, paste it here.'
    : saved ? 'A key is saved for this provider in this browser.' : 'No key saved for this provider yet.';
}

function formBaseUrl(provider) {
  const p = PROVIDERS[provider] || PROVIDERS.gemini;
  return provider === 'gemini' ? p.baseUrl : ($('#setBase').value.trim() || p.baseUrl);
}

function formProviderConfig() {
  const provider = $('#setProvider').value;
  return providerConfig({
    provider,
    model: $('#setModel').value,
    baseUrl: formBaseUrl(provider),
    apiKey: $('#setKey').value.trim(),
  });
}

async function testFormConnection() {
  const btn = $('#setTest');
  btn.disabled = true;
  showStatus($('#setStatus'), 'Testing…', 'busy');
  try {
    const out = await testProvider(formProviderConfig());
    showStatus($('#setStatus'), `Connected to ${providerLabel(out.provider)} · ${out.model}\n${out.detail} (${out.ms} ms)`, 'ok');
  } catch (e) {
    showStatus($('#setStatus'), message(e), 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function loadFormModels() {
  const btn = $('#loadModels');
  btn.disabled = true;
  showStatus($('#setStatus'), 'Loading models…', 'busy');
  try {
    const ids = await listModels(formProviderConfig());
    $('#setModelList').innerHTML = ids.map((m) => `<option value="${esc(m)}"></option>`).join('');
    if (!ids.length) showStatus($('#setStatus'), 'The provider listed no models. Type the model name by hand.', '');
    else {
      showStatus($('#setStatus'), `${ids.length} model${ids.length === 1 ? '' : 's'}: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? '…' : ''}`, 'ok');
      if (!$('#setModel').value.trim()) $('#setModel').value = ids[0];
    }
  } catch (e) {
    showStatus($('#setStatus'), message(e), 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function saveSettingsForm() {
  const provider = $('#setProvider').value;
  const model = $('#setModel').value.trim();
  const baseUrl = formBaseUrl(provider);
  const key = $('#setKey').value.trim();
  const remember = $('#setRemember').checked;
  const studioUrl = $('#setStudio').value.trim();
  if (!model) { showStatus($('#setStatus'), 'Choose a model first.', 'bad'); return; }
  if (studioUrl) {
    try { new URL(studioUrl); } catch { showStatus($('#setStatus'), 'The studio URL is not a valid URL.', 'bad'); return; }
  }
  const s = state.settings;
  s.provider = provider;
  s.rememberKey = remember;
  s.studioUrl = studioUrl;
  s.profiles[provider] = { model, baseUrl };
  try { store.saveSettings(s); } catch { toast('Browser storage is disabled: these settings last for this tab only.', 'bad'); }
  store.setKey(provider, key, remember);
  renderModelPill();
  const btn = $('#setSave');
  btn.disabled = true;
  showStatus($('#setStatus'), 'Saved. Checking the studio…', 'busy');
  await probeStudio({ quiet: true });
  await loadCatalog();
  btn.disabled = false;
  showStatus($('#setStatus'), `Saved. ${providerLabel(provider)} · ${model} writes the scripts.\n${state.studio.ok ? 'Local studio connected — you can render here.' : 'No studio server — export or download to render locally.'}`, 'ok');
  toast('Settings saved');
  renderStudioPill();
  renderValidation();
  renderBuild();
}

async function checkStudioForm() {
  const base = studio.resolveBase($('#setStudio').value.trim());
  const res = await studio.probe(base, 2500);
  if (res.ok) {
    $('#studioState').textContent = `connected to ${base}${res.settings?.ready ? '' : ' (backend not ready)'}`;
    showStatus($('#setStatus'), `Studio at ${base} answered: ${res.settings?.description || 'ok'}${res.settings?.ready ? '' : `\n${res.settings?.readyDetail || ''}`}`, res.settings?.ready ? 'ok' : 'busy');
  } else {
    $('#studioState').textContent = 'not reachable';
    showStatus($('#setStatus'), `No studio at ${base}: ${res.error}`, 'bad');
  }
}

// ---------- event wiring ----------
function bindEvents() {
  $('#newBtn').onclick = newProject;
  $('#emptyNew').onclick = newProject;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await importProject(file);
  };
  $('#projects').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) openProject(b.dataset.id);
  };
  $('#styles').onclick = (e) => {
    const b = e.target.closest('[data-style]');
    if (b) chooseStyle(b.dataset.style);
  };
  $('#styleSearch').oninput = (e) => { state.filter = e.target.value; renderStyles(); };
  $('#styleChip').onclick = () => { $('#styleSearch').focus(); $('#styles').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  $('#idea').oninput = () => { if (!state.current) return; state.current.idea = $('#idea').value; scheduleSave(); };
  $('#idea').onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); write(); } };
  $('#title').oninput = () => { if (!state.current) return; state.current.title = $('#title').value; scheduleSave(); };
  $('#format').onchange = () => { if (!state.current) return; state.current.format = $('#format').value; scheduleSave(); };
  $('#music').onchange = () => { if (!state.current) return; state.current.music = $('#music').value; scheduleSave(); };
  $('#writeBtn').onclick = write;
  $('#addScene').onclick = addScene;
  $('#exportBtn').onclick = exportProject;
  $('#deleteBtn').onclick = deleteCurrent;
  $('#buildBtn').onclick = buildAction;
  $('#downloadBtn').onclick = downloadProject;
  $('#copyCmd').onclick = copyOfflineCommand;
  $('#stopBtn').onclick = async () => {
    try { await studio.stop(state.studio.base, state.buildSlug); toast('Stopping…'); pollBuild(); } catch (e) { toast(message(e), 'bad'); }
  };
  $('#revealBtn').onclick = async () => {
    try { await studio.reveal(state.studio.base, state.buildSlug); } catch (e) { toast(message(e), 'bad'); }
  };
  $('#settingsBtn').onclick = () => openSettings();
  $('#modelPill').onclick = () => openSettings();
  $('#studioPill').onclick = () => openSettings('studio');
  $('#emptySettings').onclick = () => openSettings();

  $('#scenes').addEventListener('input', (e) => {
    const el = e.target.closest('[data-k]');
    const p = state.current;
    if (!el || !p) return;
    const i = Number(el.dataset.i);
    const key = el.dataset.k;
    const scene = p.scenes[i];
    if (!scene) return;
    scene[key] = key === 'start' || key === 'end' ? Number(el.value) || 0 : el.value;
    if (key === 'start' || key === 'end') {
      const dur = (+scene.end || 0) - (+scene.start || 0);
      const head = el.closest('.scene')?.querySelector('.dur');
      if (head) head.textContent = `${fmtSec(scene.start)}–${fmtSec(scene.end)} s · ${fmtSec(Math.max(0, dur))} s`;
      renderMeta();
    }
    if (p.status === 'done') p.status = 'script-ready';
    renderValidation();
    scheduleSave();
  });
  $('#scenes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]');
    const p = state.current;
    if (!b || !p) return;
    p.scenes.splice(Number(b.dataset.del), 1);
    p.scenes.forEach((s, i) => { s.n = i + 1; });
    if (p.status === 'done') p.status = 'script-ready';
    renderScenes();
    renderMeta();
    renderValidation();
    scheduleSave();
  });

  // settings
  $('#setProvider').onchange = updateProviderForm;
  $('#setTest').onclick = testFormConnection;
  $('#loadModels').onclick = loadFormModels;
  $('#setSave').onclick = saveSettingsForm;
  $('#setForget').onclick = () => {
    const id = $('#setProvider').value;
    store.forgetKey(id);
    $('#setKey').value = '';
    $('#setKey').placeholder = id === 'local' ? 'optional for a local server' : 'paste the key';
    $('#setKeyState').textContent = 'Key removed from this browser.';
    renderModelPill();
  };
  $('#useThis').onclick = () => {
    if (/^https?:$/.test(location.protocol)) $('#setStudio').value = location.origin;
  };
  $('#checkStudio').onclick = checkStudioForm;
  $('#setClose').onclick = () => { $('#settingsModal').hidden = true; };
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') $('#settingsModal').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#settingsModal').hidden) $('#settingsModal').hidden = true;
  });
  // the debounced save should not lose the last keystroke when the tab goes away
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { if (state.current) store.putProject(state.current); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  }
}

// ---------- boot ----------
async function autoDetectStudio() {
  if (state.studio.ok || state.settings.studioUrl) return;
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return;
  const alt = 'http://127.0.0.1:4790';
  if (studio.resolveBase('') === alt) return;
  const res = await studio.probe(alt, 1200);
  if (!res.ok) return;
  // remember this for the session only; saving it in settings makes it permanent
  state.settings.studioUrl = alt;
  state.studio = res;
  renderStudioPill();
}

(async function boot() {
  bindEvents();
  renderModelPill();
  await loadCatalog();
  await probeStudio({ quiet: true });
  await autoDetectStudio();
  await loadCatalog();
  await refreshProjects();
  const params = new URLSearchParams(location.search);
  const wanted = params.get('p') || store.lastProjectId();
  if (wanted) await openProject(wanted);
  if (!state.current) renderAll();
})();
