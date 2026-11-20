// Turning model output into the scene table Video Studio expects.
// Small local models get JSON wrong more often than hosted ones, so everything here is
// forgiving: fences, chatter around the object, trailing commas, renamed fields, missing times.

export const FORMATS = ['9:16', '16:9', '1:1'];
export const MUSIC = ['lofi', 'ambient', 'upbeat', 'epic', 'none'];

export const SCENE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // OpenAI structured outputs require every property to be listed in `required`
  required: ['title', 'format', 'music', 'scenes'],
  properties: {
    title: { type: 'string', description: 'Short title of the video' },
    format: { type: 'string', enum: FORMATS },
    music: { type: 'string', enum: MUSIC },
    scenes: {
      type: 'array',
      description: 'One picture per scene, 2–6 seconds, contiguous from 0',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'visual', 'narration', 'onscreen', 'sound'],
        properties: {
          start: { type: 'number', description: 'seconds from the start' },
          end: { type: 'number', description: 'seconds from the start' },
          visual: { type: 'string', description: 'exactly what we see' },
          narration: { type: 'string', description: 'voice-over words, "" for silence' },
          onscreen: { type: 'string', description: 'text burned into the picture, "" if none' },
          sound: { type: 'string', description: 'the sound moment' },
        },
      },
    },
  },
};

const text = (v, fallback = '') => {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) return v.map((x) => text(x)).filter(Boolean).join(' ');
  if (typeof v === 'object') {
    for (const key of ['text', 'value', 'content', 'label']) if (typeof v[key] === 'string') return v[key].trim();
    return JSON.stringify(v);
  }
  return String(v).replace(/\s+/g, ' ').trim();
};

const firstOf = (obj, names) => {
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  return undefined;
};

/** Remove a UTF-8 BOM, markdown fences and trailing commas outside strings. */
export function cleanText(input) {
  let s = String(input ?? '').replace(/^\uFEFF/, '').trim();
  s = s.replace(/^```(?:json|JSON)?\s*/m, '');
  s = s.replace(/```\s*$/m, '');
  // trailing commas: ,} or ,] (skip string contents)
  let out = '', inString = false, quote = '', escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += ch;
  }
  return out.trim();
}

/** The first balanced {...} or [...] in a string, string-aware. */
export function findJsonBlock(s) {
  const src = String(s ?? '');
  const start = src.search(/[[{]/);
  if (start < 0) return null;
  const open = src[start], close = open === '{' ? '}' : ']';
  let depth = 0, inString = false, quote = '', escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse JSON out of a chatty reply. Throws a helpful error when there is none. */
export function extractJson(input) {
  const raw = String(input ?? '');
  const attempts = [];
  const add = (v) => { if (v && !attempts.includes(v)) attempts.push(v); };
  add(raw.trim());
  add(cleanText(raw));
  const block = findJsonBlock(raw);
  if (block) { add(block); add(cleanText(block)); }

  // some small models answer with single-quoted JSON
  for (const a of [...attempts]) {
    if (!/^\s*[[{]/.test(a) || !a.includes("'")) continue;
    add(a.replaceAll(/'(?:\\.|[^'\\])*'/g, (m) => `"${m.slice(1, -1).replace(/"/g, '\\"')}"`));
  }

  for (const a of attempts) {
    if (!a) continue;
    try { return JSON.parse(a); } catch { /* next */ }
  }
  const snippet = raw.replace(/\s+/g, ' ').slice(0, 240);
  throw new Error(`the model did not return JSON${snippet ? ` (it said: “${snippet}${raw.length > 240 ? '…' : ''}”)` : ''}`);
}

const asNumber = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(?:\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return undefined;
};

function timeRange(scene) {
  const range = firstOf(scene, ['time', 'range', 'seconds', 'timing']);
  if (typeof range === 'string') {
    const m = range.match(/(\d+(?:\.\d+)?)\s*(?:s|sec)?\s*(?:-|–|—|to|→)\s*(\d+(?:\.\d+)?)/i);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  if (Array.isArray(range) && range.length === 2) return range.map(asNumber);
  return [undefined, undefined];
}

/**
 * Coerce whatever the model sent into the exact scene-table shape.
 * `opts.style` pins every scene to the style picked in the UI.
 */
export function normalizeScript(input, { style = null, format = '9:16' } = {}) {
  let data = input;
  if (typeof data === 'string') data = extractJson(data);
  if (!data || typeof data !== 'object') throw new Error('the model returned no script');
  if (Array.isArray(data)) data = { scenes: data };
  if (data.project && typeof data.project === 'object') data = { ...data.project, ...data };
  if (!data.scenes && data.storyboard) data = { ...data, scenes: data.storyboard };
  if (!data.scenes && data.beats) data = { ...data, scenes: data.beats };
  if (!data.scenes && data.shots) data = { ...data, scenes: data.shots };
  if (!data.scenes && data.script?.scenes) data = { ...data, scenes: data.script.scenes };

  const rawScenes = Array.isArray(data.scenes) ? data.scenes
    : data.scenes && typeof data.scenes === 'object' ? Object.values(data.scenes) : [];
  if (!rawScenes.length) throw new Error('the model returned no scenes');

  const scenes = [];
  let prevEnd = 0;
  for (const raw of rawScenes) {
    if (!raw || typeof raw !== 'object') continue;
    const [rangeStart, rangeEnd] = timeRange(raw);
    let start = asNumber(firstOf(raw, ['start', 'from', 'startTime', 'start_time', 't0'])) ?? rangeStart;
    let end = asNumber(firstOf(raw, ['end', 'to', 'endTime', 'end_time', 't1'])) ?? rangeEnd;
    const duration = asNumber(firstOf(raw, ['duration', 'length', 'seconds', 'dur']));
    if (start === undefined && end !== undefined && duration !== undefined) start = end - duration;
    if (end === undefined && start !== undefined) end = start + (duration && duration > 0.4 ? duration : Math.max(2, Math.min(6, Math.round((String(raw.visual || raw.description || '').split(/\s+/).length || 12) / 4))));
    if (start === undefined && end === undefined) { start = prevEnd; end = start + (duration && duration > 0.4 ? duration : 3); }
    if (start === undefined) start = Math.max(0, end - 3);
    if (end === undefined) end = start + 3;
    start = Math.max(0, start);
    if (!(end > start + 0.2)) end = start + Math.max(0.5, duration || 3);
    start = Math.round(start * 10) / 10;
    end = Math.round(end * 10) / 10;
    if (end <= start) end = Math.round((start + 3) * 10) / 10;

    const visual = text(firstOf(raw, ['visual', 'description', 'action', 'shot', 'picture', 'scene', 'what', 'summary']));
    const narration = text(firstOf(raw, ['narration', 'voiceover', 'voice_over', 'vo', 'speech', 'line', 'dialogue']));
    const onscreen = text(firstOf(raw, ['onscreen', 'on_screen', 'onscreen_text', 'onScreen', 'text', 'caption', 'title', 'overlay']));
    const sound = text(firstOf(raw, ['sound', 'sfx', 'audio', 'sound_effect', 'soundEffect']));
    const notes = text(firstOf(raw, ['notes', 'note', 'director_notes', 'comment']));
    if (!visual && !narration && !onscreen) continue;

    scenes.push({
      n: scenes.length + 1,
      start, end,
      tool: style || text(firstOf(raw, ['tool', 'toolId', 'tool_id', 'style'])) || '',
      visual, narration, onscreen, sound, notes,
      status: 'pending',
    });
    prevEnd = end;
  }

  if (!scenes.length) throw new Error('the model returned scene entries but none had any visual, narration or on-screen text');

  scenes.sort((a, b) => a.start - b.start || a.end - b.end);
  scenes.forEach((s, i) => (s.n = i + 1));

  const fmt = FORMATS.includes(String(data.format)) ? String(data.format) : FORMATS.includes(format) ? format : '9:16';
  const music = MUSIC.includes(String(data.music)) ? String(data.music) : 'lofi';
  const title = text(data.title || data.name) || text(scenes[0]?.visual).slice(0, 60) || 'Untitled video';

  return { title, format: fmt, music, scenes };
}

const toType = (t) => {
  const map = { object: 'OBJECT', array: 'ARRAY', string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', null: 'NULL' };
  return map[String(t).toLowerCase()] || String(t).toUpperCase();
};

/** JSON Schema → the OpenAPI subset Gemini's responseSchema/functionDeclarations accept. */
export function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (['additionalProperties', '$schema', 'strict', 'description'].includes(key)) {
      if (key === 'description' && typeof value === 'string') out.description = value.slice(0, 1000);
      continue;
    }
    if (key === 'type') {
      if (Array.isArray(value)) {
        const nonNull = value.filter((v) => String(v).toLowerCase() !== 'null');
        out.type = toType(nonNull[0] || 'string');
        if (nonNull.length !== value.length) out.nullable = true;
      } else out.type = toType(value);
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [name, schema] of Object.entries(value)) out.properties[name] = toGeminiSchema(schema);
      out.propertyOrdering = Object.keys(value);
      continue;
    }
    if (key === 'items') { out.items = toGeminiSchema(value); continue; }
    if (key === 'enum') { out.enum = value.map(String); continue; }
    if (key === 'required') { out.required = value; continue; }
    out[key] = toGeminiSchema(value);
  }
  return out;
}
