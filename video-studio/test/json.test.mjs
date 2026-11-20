import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normalizeScript, toGeminiSchema, SCENE_SCHEMA } from '../llm/json.mjs';

test('extractJson finds JSON inside chatter, fences and trailing commas', () => {
  const messy = `Sure! Here is the script:\n\`\`\`json\n{"title": "Fire", "scenes": [{"start": 0, "end": 3,},],}\n\`\`\`\nHope it helps.`;
  const data = extractJson(messy);
  assert.equal(data.title, 'Fire');
  assert.equal(data.scenes.length, 1);
});

test('extractJson handles braces inside strings', () => {
  const data = extractJson('{"visual": "a sign that says {hello}", "n": 1}');
  assert.equal(data.visual, 'a sign that says {hello}');
});

test('extractJson repairs single-quoted keys from small models', () => {
  const data = extractJson(`{'title': 'Cat', 'scenes': [{'start': 0, 'end': 2, 'visual': 'a cat'}]}`);
  assert.equal(data.title, 'Cat');
  assert.equal(data.scenes[0].visual, 'a cat');
});

test('extractJson throws a readable error when there is no JSON', () => {
  assert.throws(() => extractJson('I cannot help with that.'), /did not return JSON/);
});

test('normalizeScript accepts aliases, missing times and unordered scenes', () => {
  const raw = {
    name: 'The Kite',
    format: 'portrait',
    scenes: [
      { time: '5-8', description: 'the kite climbs', voiceover: 'Up it goes', caption: 'Higher' },
      { start: 0, end: 5, action: 'a child runs', narration: 'Run!', onScreen: 'GO', sfx: 'wind' },
    ],
  };
  const s = normalizeScript(raw, { style: 'tvhead/stick', format: '9:16' });
  assert.equal(s.title, 'The Kite');
  assert.equal(s.format, '9:16');
  assert.equal(s.scenes.length, 2);
  assert.equal(s.scenes[0].start, 0); // sorted
  assert.equal(s.scenes[0].tool, 'tvhead/stick');
  assert.equal(s.scenes[0].onscreen, 'GO');
  assert.equal(s.scenes[1].start, 5);
  assert.equal(s.scenes[1].narration, 'Up it goes');
  assert.equal(s.scenes[1].onscreen, 'Higher');
  assert.equal(s.scenes[1].n, 2);
});

test('normalizeScript fills timing when a model forgets it', () => {
  const s = normalizeScript({ title: 'T', scenes: [{ visual: 'one' }, { visual: 'two' }, { visual: 'three' }] });
  assert.deepEqual(s.scenes.map((x) => [x.start, x.end]), [[0, 3], [3, 6], [6, 9]]);
});

test('normalizeScript rejects empty scripts and empty scenes', () => {
  assert.throws(() => normalizeScript({ title: 'x', scenes: [] }), /no scenes/);
  assert.throws(() => normalizeScript({ scenes: [{ start: 0, end: 3 }] }), /none had any/);
});

test('normalizeScript fixes reversed and negative times', () => {
  const s = normalizeScript({ scenes: [{ start: -5, end: -2, visual: 'x' }, { start: 9, end: 4, visual: 'y' }] });
  for (const scene of s.scenes) assert.ok(scene.end > scene.start, `${scene.start}-${scene.end}`);
  assert.ok(s.scenes.every((x) => x.start >= 0));
});

test('Gemini schema conversion drops what Google rejects', () => {
  const g = toGeminiSchema(SCENE_SCHEMA);
  assert.equal(g.type, 'OBJECT');
  assert.equal(g.additionalProperties, undefined);
  assert.equal(g.properties.scenes.type, 'ARRAY');
  assert.equal(g.properties.scenes.items.type, 'OBJECT');
  assert.equal(g.properties.scenes.items.properties.start.type, 'NUMBER');
  assert.deepEqual(g.properties.music.enum, ['lofi', 'ambient', 'upbeat', 'epic', 'none']);
  assert.deepEqual(g.properties.scenes.items.propertyOrdering.slice(0, 2), ['start', 'end']);
});
