// Video Studio UI: prompt (always open) → the chosen model writes the script → you edit/validate → it generates the video.
// The model backend (Claude Code, Gemini, OpenAI GPT or a local GGUF file) is picked in the ⚙ panel.
const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => { const r = await fetch(url, { cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...opts }); return r.json(); };
let CAT = null, P = null, slug = new URLSearchParams(location.search).get('p'), dirty = false, saveTimer = null, selected = null, SETTINGS = null;

const toolById = (id) => CAT.tools.find((t) => t.id === id);

// ---------- model backend (Claude Code, Gemini, OpenAI GPT, local GGUF) ----------
const backendLabel = () => SETTINGS?.label || 'Claude Code';
function applyBackend() {
  $('#writingText').textContent = `${P?.llm?.label || backendLabel()} is writing the script…`;
  const b = $('#backendBadge');
  if (!SETTINGS) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = SETTINGS.description || SETTINGS.label;
  b.classList.toggle('ready', !!SETTINGS.ready && !SETTINGS.unknown);
  b.title = `${SETTINGS.description}\n${SETTINGS.readyDetail || ''}\nClick to change the model`;
  $('#modelBtn').title = `Model: ${SETTINGS.description}${SETTINGS.ready ? '' : ' (not ready)'} — click to change`;
}
async function loadSettings() { try { SETTINGS = await api('/api/settings'); } catch { SETTINGS = null; } applyBackend(); }
const providerById = (id) => (SETTINGS?.providers || []).find((p) => p.id === id);
function llmStatus(text, kind = '') {
  const el = $('#llmStatus');
  el.hidden = !text; el.className = 'llm-status full ' + kind; el.textContent = text || '';
}
function openModel() {
  if (!SETTINGS || !SETTINGS.providers) { alert('Could not read the model settings. Is the studio server running?'); return; }
  const s = SETTINGS;
  $('#llmProvider').innerHTML = s.providers.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  $('#llmProvider').value = s.provider;
  $('#llmScriptModel').value = s.scriptModel || '';
  $('#llmBuildModel').value = s.buildModel || '';
  $('#llmApiKey').value = '';
  $('#llmApiKey').placeholder = s.hasApiKey ? (s.apiKeyFromEnv ? `using ${s.apiKeyFromEnv}` : 'saved — type to replace') : 'paste the key';
  $('#llmBaseUrl').value = s.baseUrl || '';
  $('#llmGguf').value = s.ggufPath || '';
  $('#llmLlamaServer').value = s.llamaServer || '';
  $('#llmPort').value = s.localPort || 8080;
  $('#llmCtx').value = s.ctxSize || 16384;
  $('#llmGpuLayers').value = s.gpuLayers ?? 'auto';
  $('#llmRuntime').value = s.localRuntime || 'auto';
  $('#llmToolMode').value = s.toolMode || 'auto';
  $('#llmMaxSteps').value = s.maxSteps || 160;
  $('#llmCurrent').innerHTML = `Active: <b>${esc(s.description)}</b> — ${s.ready ? 'ready' : esc(s.readyDetail)}`;
  $('#llmModels').innerHTML = '';
  llmStatus('');
  updateProviderUI({ defaults: false });
  if (s.error) llmStatus(`The settings file could not be read (${s.error}). Saving below repairs it and keeps a .bak copy.`, 'bad');
  $('#modelModal').hidden = false;
}
function updateProviderUI({ defaults = false } = {}) {
  const id = $('#llmProvider').value, p = providerById(id) || {};
  $('#llmProviderHint').innerHTML = esc(p.hint || '') + (p.keyUrl ? ` <a href="${p.keyUrl}" target="_blank" rel="noopener">Get a key ↗</a>` : '');
  $('#llmLocalFields').classList.toggle('on', id === 'local');
  $('#llmKeyLabel').hidden = id === 'claude' || id === 'local';
  if (defaults) {
    const m = p.models || {};
    $('#llmScriptModel').value = m.script || '';
    $('#llmBuildModel').value = m.build || '';
    $('#llmBaseUrl').value = id === 'local' ? localBaseFor($('#llmRuntime').value) : p.baseUrl || '';
  }
  $('#llmKeyState').textContent = id === 'local' ? 'Local servers need no key unless you set one on the server.' : id === 'claude' ? 'Claude Code uses your Claude plan — no API key.' : '';
  $('#llmClearKey').hidden = !(SETTINGS?.hasApiKey && id === SETTINGS?.provider);
}
function localBaseFor(runtime) {
  if (runtime === 'ollama') return 'http://127.0.0.1:11434/v1';
  if (runtime === 'lmstudio') return 'http://127.0.0.1:1234/v1';
  return `http://127.0.0.1:${+$('#llmPort').value || 8080}/v1`;
}
const llmPatch = () => ({
  provider: $('#llmProvider').value,
  scriptModel: $('#llmScriptModel').value.trim(),
  buildModel: $('#llmBuildModel').value.trim(),
  apiKey: $('#llmApiKey').value.trim(),
  baseUrl: $('#llmBaseUrl').value.trim(),
  ggufPath: $('#llmGguf').value.trim(),
  llamaServer: $('#llmLlamaServer').value.trim(),
  localRuntime: $('#llmRuntime').value,
  localPort: +$('#llmPort').value || 8080,
  ctxSize: +$('#llmCtx').value || 16384,
  gpuLayers: $('#llmGpuLayers').value.trim() || 'auto',
  toolMode: $('#llmToolMode').value,
  maxSteps: +$('#llmMaxSteps').value || 160,
});
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// ---------- catalog (only tools with a working example) ----------
function renderCatalog() {
  const f = $('#filter').value.trim().toLowerCase(), nav = $('#catalog'); nav.innerHTML = '';
  for (const t of CAT.tools) {
    const styles = t.styles.filter((s) => !f || (t.name + ' ' + s.name).toLowerCase().includes(f));
    if (!styles.length) continue;
    const el = document.createElement('div'); el.className = 'tool';
    el.innerHTML = `<button class="tool-row" data-tool="${t.id}" data-style="${styles[0].id}"><span class="code">‹›</span><span class="name">${esc(t.name)}</span></button>`;
    if (styles.length > 1 || styles[0].name !== t.name) {
      const ul = document.createElement('div'); ul.className = 'styles';
      styles.forEach((s, i) => ul.insertAdjacentHTML('beforeend', `<button class="style-row ${s.example ? '' : 'noex'}" data-tool="${t.id}" data-style="${s.id}">${esc(s.name)}<span class="v">${s.example ? 'v' + (i + 1) : 'no preview yet'}</span></button>`));
      el.appendChild(ul);
    }
    nav.appendChild(el);
  }
  nav.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { select(b.dataset.tool, b.dataset.style); $('#main').scrollTo({ top: 0 }); }));
  markActive();
}
function markActive() {
  document.querySelectorAll('.style-row').forEach((b) => b.classList.toggle('active', !!selected && b.dataset.tool === selected.tool && b.dataset.style === selected.style));
  document.querySelectorAll('.tool-row').forEach((b) => b.classList.toggle('active', !!selected && b.dataset.tool === selected.tool && !b.nextElementSibling));
}
function select(toolId, styleId) {
  const t = toolById(toolId); if (!t) return;
  const st = t.styles.find((s) => s.id === styleId) || t.styles.find((s) => s.example) || t.styles[0];
  if (!st) return;
  selected = { tool: toolId, style: st.id };
  markActive();
  $('#previewTitle').textContent = st.name !== t.name ? st.name : t.name;
  $('#previewSub').textContent = st.name !== t.name ? t.name : '';
  if (st.example) { $('#noVideo').hidden = true; showVideo('/' + st.example); } else { const v = $('#player'); v.pause(); v.removeAttribute('src'); v.load(); $('#noVideo').hidden = false; $('#noVideo').innerHTML = `No preview of <b>${esc(st.name)}</b> yet: it is rendering in the background.<br>You can still pick this style and write a prompt.`; }
  const kind = t.example === 'fire' ? 'the discovery of fire' : t.example;
  $('#toolInfo').innerHTML = `<span>${esc(t.what)}</span>${t.speed ? `<span><b>Speed</b> ${esc(t.speed)}</span>` : ''}${kind ? `<span><b>Example</b> ${esc(kind)}</span>` : ''}`;
  $('#useInScene').disabled = !P || !P.scenes.length;
  $('#promptStyle').textContent = st.name !== t.name ? `${st.name} · ${t.name}` : t.name;
}
function showVideo(src, loop = true) {
  const v = $('#player'); v.loop = loop; $('#noVideo').hidden = true;
  if (v.getAttribute('src') !== src) { v.src = src; v.play().catch(() => {}); }
}
$('#mute').onclick = () => { const v = $('#player'); v.muted = !v.muted; $('#mute').textContent = v.muted ? '🔇' : '🔊'; };
$('#filter').oninput = renderCatalog;
$('#useInScene').onclick = (e) => {
  if (!P || !selected) return;
  e.stopPropagation();
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  const r = e.target.getBoundingClientRect(); m.style.left = r.left + 'px'; m.style.top = r.bottom + 4 + 'px';
  const value = `${selected.tool}/${selected.style}`;
  m.innerHTML = P.scenes.map((s) => `<button data-n="${s.n}">Scene ${s.n} · ${s.start}–${s.end}s</button>`).join('') + `<button data-n="all">All scenes</button>`;
  m.querySelectorAll('button').forEach((b) => (b.onclick = () => { P.scenes.forEach((s) => { if (b.dataset.n === 'all' || String(s.n) === b.dataset.n) s.tool = value; }); m.remove(); renderScenes(); touch(); }));
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
};

// ---------- prompt → script ----------
$('#promptForm').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim(); if (!prompt) { $('#prompt').focus(); return; }
  $('#writeScript').disabled = true;
  const r = await api('/api/script', { method: 'POST', body: JSON.stringify({ prompt, format: $('#newFormat').value, style: selected ? `${selected.tool}/${selected.style}` : null }) });
  $('#writeScript').disabled = false;
  if (r.error) return alert(r.error);
  $('#prompt').value = '';
  history.replaceState(null, '', '?p=' + r.slug); slug = r.slug;
  P = await api('/api/project/' + slug); await loadProjects(); renderProject();
  $('#project').scrollIntoView({ behavior: 'smooth' });
};
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#promptForm').requestSubmit(); });

// ---------- project ----------
$('#newVideo').onclick = async () => {
  if (dirty) await save();
  P = null; slug = null; dirty = false; lastStatus = null;
  history.replaceState(null, '', location.pathname);
  $('#prompt').value = ''; $('#finalModal').hidden = true; document.title = 'Video Studio';
  await loadProjects(); renderProject();
  $('#main').scrollTo({ top: 0, behavior: 'smooth' }); $('#prompt').focus();
};
async function loadProjects() {
  const list = await api('/api/projects'), pick = $('#projectPick');
  pick.innerHTML = '<option value="">Video Studio · new video</option>' + list.map((p) => `<option value="${p.slug}">${esc(p.title || p.slug)}</option>`).join('');
  pick.value = slug || '';
  pick.onchange = () => { location.search = pick.value ? '?p=' + pick.value : ''; };
}
function toolOptions(cur) {
  let html = '<option value="">— pick —</option>', found = false;
  for (const t of CAT.tools) {
    const st = t.styles; if (!st.length) continue;
    html += `<optgroup label="${esc(t.name)}">` + st.map((s) => { const v = `${t.id}/${s.id}`; if (v === cur) found = true; return `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(s.name)}</option>`; }).join('') + '</optgroup>';
  }
  if (cur && !found) html += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  return html;
}
function renderScenes() {
  const tb = $('#sceneRows'); tb.innerHTML = '';
  const locked = ['building', 'writing-script'].includes(P.status);
  P.scenes.forEach((s, i) => {
    const tr = document.createElement('tr'); tr.className = s.status || '';
    tr.innerHTML = `<td class="n">${s.n}</td>
      <td class="time"><input type="number" step="0.1" min="0" data-k="start" value="${s.start}">–<input type="number" step="0.1" min="0" data-k="end" value="${s.end}"></td>
      <td class="toolc"><select data-k="tool">${toolOptions(s.tool)}</select>${s.clip ? `<span class="clip" data-clip="${esc(s.clip)}">▶ rendered clip</span>` : ''}</td>
      <td><textarea data-k="visual">${esc(s.visual)}</textarea></td>
      <td><textarea data-k="narration">${esc(s.narration)}</textarea></td>
      <td><textarea data-k="onscreen">${esc(s.onscreen)}</textarea></td>
      <td><textarea data-k="sound">${esc(s.sound)}</textarea></td>
      <td><textarea data-k="notes" placeholder="specs for this scene…">${esc(s.notes)}</textarea></td>
      <td class="del"><button title="Remove scene">×</button></td>`;
    tr.querySelectorAll('[data-k]').forEach((el) => { el.disabled = locked; el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { const k = el.dataset.k; s[k] = el.type === 'number' ? +el.value : el.value; touch(); if (k === 'start' || k === 'end') updateTotal(); if (k === 'tool' && s.tool) { const [t, st] = s.tool.split('/'); select(t, st); } }); });
    const del = tr.querySelector('.del button'); del.disabled = locked;
    del.onclick = () => { P.scenes.splice(i, 1); P.scenes.forEach((x, j) => (x.n = j + 1)); renderScenes(); touch(); };
    const c = tr.querySelector('.clip'); if (c) c.onclick = () => { showVideo('/files/' + P.slug + '/' + c.dataset.clip); $('#previewTitle').textContent = `Scene ${s.n}`; $('#previewSub').textContent = 'rendered clip'; $('#main').scrollTo({ top: 0, behavior: 'smooth' }); };
    tr.querySelector('select').addEventListener('focus', () => { if (s.tool) { const [t, st] = s.tool.split('/'); select(t, st); } });
    tb.appendChild(tr);
  });
  updateTotal();
}
function updateTotal() {
  const end = Math.max(0, ...P.scenes.map((s) => +s.end || 0));
  const words = P.scenes.map((s) => s.narration || '').join(' ').split(/\s+/).filter(Boolean).length;
  $('#total').textContent = `${P.scenes.length} scenes · ${end.toFixed(1)} s · ${words} words of narration`;
}
function styleNameOf(v) { const [t, s] = String(v || '').split('/'); const tool = toolById(t); const st = tool?.styles.find((x) => x.id === s); return st ? (st.name === tool.name ? tool.name : `${st.name} (${tool.name})`) : v; }
$('#projectStyle').onchange = () => {
  const v = $('#projectStyle').value; if (!P || !v) return;
  P.style = v; P.styleName = styleNameOf(v); P.scenes.forEach((s) => (s.tool = v));
  const [t, s] = v.split('/'); select(t, s);
  renderScenes(); renderProject(); touch();
};
function renderProject() {
  $('#empty').hidden = !!P; $('#proj').hidden = !P;
  if (!P) return;
  $('#title').value = P.title || ''; $('#format').value = P.format || '9:16'; $('#voice').value = P.voice?.on === true ? P.voice.voice : 'none'; $('#music').value = P.music && P.music !== 'auto' ? P.music : 'lofi';
  $('#ideaLine').textContent = (P.llm ? `Model: ${P.llm.label} · ${P.llm.model} · ` : '') + (P.styleName ? 'Style: ' + P.styleName + ' · ' : '') + (P.idea ? 'Prompt: ' + P.idea : '');
  const ps = $('#projectStyle'), cur = P.style || P.scenes.find((s) => s.tool)?.tool || '';
  ps.innerHTML = toolOptions(cur).replace('— pick —', 'Style: pick one'); ps.value = cur;
  ps.disabled = ['building', 'writing-script'].includes(P.status);
  renderScenes(); renderLive(); applyBackend();
}
const STATUS = { 'writing-script': 'writing script…', 'script-ready': 'script ready: edit & validate', ready: 'script ready: edit & validate', draft: 'draft', 'build-requested': 'waiting for the builder', building: 'generating video…', done: 'done', error: 'error' };
function renderLive() {
  const st = $('#status'); st.textContent = STATUS[P.status] || P.status; st.className = 'status ' + P.status;
  const writing = P.status === 'writing-script';
  $('#writing').hidden = !writing; $('#scriptBlock').hidden = writing;
  const busy = ['build-requested', 'building'].includes(P.status);
  $('#build').disabled = busy || !P.scenes.length;
  $('#build').textContent = busy ? 'Generating…' : P.status === 'done' ? 'Generate again' : 'Validate script & generate video';
  $('#stop').hidden = P.status !== 'building';
  $('#addScene').disabled = busy;
  $('#log').innerHTML = (P.log || []).slice(-80).map((l) => `<li><time>${new Date(l.at).toLocaleTimeString()}</time>${esc(l.text)}</li>`).join('');
  $('#log').parentElement.scrollTop = 1e6;
  $('#showFinal').hidden = !P.final;
}
// ---------- the finished video: its own window, closes only with "Close" ----------
function openFinal(autoplay = true) {
  if (!P || !P.final) return;
  const m = $('#finalModal'), v = $('#finalVideo'), src = '/files/' + P.slug + '/' + P.final;
  $('#finalTitle').textContent = P.title || P.slug;
  $('#finalPath').textContent = P.savedPath || '(copying to the outputs folder…)';
  const dl = $('#finalDownload'); dl.href = src; dl.download = `${(P.title || P.slug).replace(/[\/:*?"<>|]+/g, '').trim() || P.slug}.mp4`;
  if (v.getAttribute('src') !== src) v.src = src;
  $('#player').pause();
  m.hidden = false;
  if (autoplay) { v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }
}
function announceFinal() {
  openFinal(true);
  document.title = '✅ ' + (P.title || 'Video') + ' is ready';
  try { if (Notification.permission === 'granted') new Notification('Your video is ready', { body: P.title }); } catch {}
}
$('#showFinal').onclick = () => openFinal(true);
$('#finalClose').onclick = () => { const v = $('#finalVideo'); v.pause(); $('#finalModal').hidden = true; document.title = 'Video Studio'; $('#player').play().catch(() => {}); };
$('#finalReveal').onclick = async () => { const r = await api(`/api/project/${P.slug}/reveal`, { method: 'POST', body: '{}' }); if (r.path) { P.savedPath = r.path; $('#finalPath').textContent = r.path; } };
$('#finalCopyPath').onclick = () => { navigator.clipboard?.writeText($('#finalPath').textContent); $('#finalCopyPath').textContent = 'Copied'; setTimeout(() => ($('#finalCopyPath').textContent = 'Copy path'), 1500); };
function touch() { dirty = true; $('#saveState').textContent = 'saving…'; clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
async function save() {
  if (!P) return;
  clearTimeout(saveTimer);
  P = await api('/api/project/' + P.slug, { method: 'PUT', body: JSON.stringify({ title: P.title, format: P.format, voice: P.voice, music: P.music, scenes: P.scenes, style: P.style, styleName: P.styleName }) });
  dirty = false; $('#saveState').textContent = 'saved'; renderLive();
}
$('#title').oninput = () => { P.title = $('#title').value; touch(); };
$('#format').onchange = () => { P.format = $('#format').value; touch(); };
$('#voice').onchange = () => { const v = $('#voice').value; P.voice = v === 'none' ? { engine: 'kokoro', voice: 'none', on: false } : { engine: 'kokoro', voice: v, on: true }; touch(); };
$('#music').onchange = () => { P.music = $('#music').value; touch(); };
$('#addScene').onclick = () => { if (!P) return; const last = P.scenes[P.scenes.length - 1]; const s0 = last ? +last.end : 0; P.scenes.push({ n: P.scenes.length + 1, start: s0, end: +(s0 + 3).toFixed(1), tool: last ? last.tool : '', visual: '', narration: '', onscreen: '', sound: '', notes: '' }); renderScenes(); touch(); };
$('#build').onclick = async () => {
  if (!confirm(`Generate the video from this script? ${backendLabel()} will render every scene (this can take a while).`)) return;
  if (dirty) await save();
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
  P = await api(`/api/project/${P.slug}/build`, { method: 'POST', body: '{}' }); renderScenes(); renderLive();
};
$('#stop').onclick = async () => { P = await api(`/api/project/${P.slug}/stop`, { method: 'POST', body: '{}' }); renderScenes(); renderLive(); };

// live updates while Claude writes or builds (never overwrite what you're typing)
let lastStatus = null;
setInterval(async () => {
  if (!P || dirty) return;
  const fresh = await api('/api/project/' + P.slug); if (fresh.error) return;
  const changedScenes = JSON.stringify(fresh.scenes) !== JSON.stringify(P.scenes) || fresh.status !== lastStatus;
  const becameDone = fresh.final && fresh.final !== P.final;
  P = fresh;
  if (changedScenes && !document.activeElement?.closest?.('#sceneRows')) { renderProject(); if (lastStatus === 'writing-script') loadProjects(); }
  lastStatus = P.status;
  renderLive();
  if (becameDone) announceFinal();
}, 2500);

$('#modelBtn').onclick = openModel;
$('#backendBadge').onclick = openModel;
$('#modelClose').onclick = () => { $('#modelModal').hidden = true; };
$('#modelModal').addEventListener('click', (e) => { if (e.target.id === 'modelModal') $('#modelModal').hidden = true; });
$('#llmProvider').onchange = () => updateProviderUI({ defaults: true });
$('#llmRuntime').onchange = () => {
  const base = $('#llmBaseUrl'), current = base.value.trim();
  const known = ['', 'http://127.0.0.1:8080/v1', 'http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'];
  if (known.includes(current)) base.value = localBaseFor($('#llmRuntime').value);
};
$('#llmPort').onchange = () => {
  const base = $('#llmBaseUrl');
  if (base.value.trim() === '' || /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base.value.trim())) base.value = localBaseFor($('#llmRuntime').value);
};
$('#llmSave').onclick = async () => {
  $('#llmSave').disabled = true;
  llmStatus('Saving…');
  const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify(llmPatch()) });
  $('#llmSave').disabled = false;
  if (r.error) return llmStatus(`Could not save: ${r.error}${r.hint ? '\n' + r.hint : ''}`, 'bad');
  SETTINGS = r;
  applyBackend();
  $('#llmCurrent').innerHTML = `Active: <b>${esc(r.description)}</b> — ${r.ready ? 'ready' : esc(r.readyDetail)}`;
  llmStatus(`Saved. ${r.description} is now the backend.${r.ready ? '' : '\n' + (r.readyDetail || '')}`, r.ready ? 'ok' : '');
};
$('#llmTest').onclick = async () => {
  $('#llmTest').disabled = true;
  llmStatus('Testing — a local GGUF model may need a minute to load…');
  const r = await api('/api/settings/test', { method: 'POST', body: JSON.stringify(llmPatch()) });
  $('#llmTest').disabled = false;
  if (r.ok) llmStatus(`Connected to ${r.backend || r.label}: “${r.reply}” (${r.ms} ms, model ${r.model})`, 'ok');
  else llmStatus(`Not connected: ${r.error}${r.hint ? '\n' + r.hint : ''}`, 'bad');
};
$('#llmLoadModels').onclick = async () => {
  $('#llmLoadModels').disabled = true;
  llmStatus('Loading models…');
  const r = await api('/api/settings/models?provider=' + encodeURIComponent($('#llmProvider').value));
  $('#llmLoadModels').disabled = false;
  if (r.models?.length) {
    $('#llmModels').innerHTML = r.models.map((m) => `<option value="${esc(m)}"></option>`).join('');
    llmStatus(`${r.models.length} model${r.models.length === 1 ? '' : 's'}: ${r.models.slice(0, 12).join(', ')}${r.models.length > 12 ? '…' : ''}${r.note ? '\n' + r.note : ''}`, 'ok');
  } else llmStatus(r.error ? `Could not list models: ${r.error}${r.hint ? '\n' + r.hint : ''}` : (r.note || 'No models reported.'), r.error ? 'bad' : '');
};
$('#llmClearKey').onclick = async () => {
  const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ clearApiKey: true }) });
  if (r.error) return llmStatus(r.error, 'bad');
  SETTINGS = r; applyBackend();
  $('#llmApiKey').value = ''; $('#llmApiKey').placeholder = 'paste the key';
  llmStatus('Saved key removed.', 'ok');
  updateProviderUI({ defaults: false });
};

(async () => {
  CAT = await api('/api/catalog');
  await loadSettings();
  await loadProjects();
  if (slug) { P = await api('/api/project/' + slug); if (P.error) P = null; }
  lastStatus = P?.status;
  renderCatalog(); renderProject();
  const first = P?.scenes?.find((s) => s.tool);
  if (first) { const [t, s] = first.tool.split('/'); select(t, s); } else select('tvhead', 'prehistoric');
  if (!P) $('#prompt').focus();
})();
