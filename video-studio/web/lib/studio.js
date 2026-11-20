// The optional local studio server: project hand-off, rendering, progress and the final video.
// Everything here is plain fetch; when no server is reachable the app stays fully usable and
// offers a download + command instead.

export const slugify = (text) => String(text || '')
  .toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  .replace(/^-+|-+$/g, '') || 'video';

export function resolveBase(studioUrl) {
  const explicit = String(studioUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin;
  return 'http://127.0.0.1:4790';
}

async function api(base, method, path, body, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: 'no-store',
    });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? `The studio server did not answer within ${Math.round(timeoutMs / 1000)} s` : 'Could not reach the studio server');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(data?.error || `${method} ${path} → HTTP ${res.status}`);
  return data ?? {};
}

/** Is a studio server reachable, and what backend does it use? */
export async function probe(base, timeoutMs = 2500) {
  try {
    const settings = await api(base, 'GET', '/api/settings', undefined, timeoutMs);
    if (!settings || !Array.isArray(settings.providers)) {
      return { ok: false, base, error: 'That address answered, but it is not a Video Studio server', settings: null };
    }
    return { ok: true, base, settings };
  } catch (e) {
    return { ok: false, base, error: e.message, settings: null };
  }
}

export async function listProjects(base) {
  const rows = await api(base, 'GET', '/api/projects');
  return Array.isArray(rows) ? rows : [];
}
export async function getProject(base, slug) {
  const p = await api(base, 'GET', `/api/project/${encodeURIComponent(slug)}`);
  if (!p || !Array.isArray(p.scenes)) throw new Error('The studio answered with something that is not a project');
  return p;
}
export const build = (base, slug) => api(base, 'POST', `/api/project/${encodeURIComponent(slug)}/build`, {});
export const stop = (base, slug) => api(base, 'POST', `/api/project/${encodeURIComponent(slug)}/stop`, {});
export const reveal = (base, slug) => api(base, 'POST', `/api/project/${encodeURIComponent(slug)}/reveal`, {}, 8000);

export const fileUrl = (base, slug, file) => {
  const rel = String(file || 'final.mp4').split('/').filter((s) => s && s !== '.' && s !== '..').map(encodeURIComponent).join('/');
  return `${base}/files/${encodeURIComponent(slug)}/${rel}`;
};

export const projectShape = (p) => ({
  title: String(p.title || '').trim() || 'Untitled video',
  idea: String(p.idea || ''),
  format: p.format || '9:16',
  voice: p.voice || { engine: 'kokoro', voice: 'none', on: false },
  music: p.music || 'lofi',
  style: p.style || '',
  styleName: p.styleName || '',
  scenes: (p.scenes || []).map((s) => ({
    n: s.n, start: s.start, end: s.end, tool: s.tool || p.style || '',
    visual: s.visual || '', narration: s.narration || '', onscreen: s.onscreen || '',
    sound: s.sound || '', notes: s.notes || '',
  })),
});

/** Send a browser project to the studio (creating or updating it) and return its slug. */
export async function importProject(base, project, existingSlug = '') {
  let slug = existingSlug || slugify(project.title || project.idea || 'video');
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) slug = slugify(slug);
  const rows = await listProjects(base).catch(() => []);
  const taken = new Set(rows.map((r) => r.slug));
  if (!existingSlug || !taken.has(slug)) {
    const first = slug;
    let n = 2;
    while (taken.has(slug)) slug = `${first}-${n++}`;
  }
  await api(base, 'PUT', `/api/project/${encodeURIComponent(slug)}`, projectShape(project));
  return slug;
}
