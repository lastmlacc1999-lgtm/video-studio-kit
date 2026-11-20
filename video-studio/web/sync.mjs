#!/usr/bin/env node
// Keep the static browser app self-contained: copy the shared scene helpers and script prompt
// into web/lib, and generate the style catalog the app uses when no studio server is running.
//
//   node video-studio/web/sync.mjs      (or: npm run web:sync)
//
// test/web-app.test.mjs fails if these copies drift from their sources.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(HERE, '..');
const lib = path.join(HERE, 'lib');
fs.mkdirSync(lib, { recursive: true });

const copies = [
  [path.join(STUDIO, 'llm', 'json.mjs'), path.join(lib, 'scene.js')],
  [path.join(STUDIO, 'llm', 'script-prompt.mjs'), path.join(lib, 'prompt.js')],
];
for (const [from, to] of copies) fs.copyFileSync(from, to);

const catalog = JSON.parse(fs.readFileSync(path.join(STUDIO, 'catalog.json'), 'utf8'));
const styles = {
  generatedFrom: 'video-studio/catalog.json',
  subject: catalog.subject,
  groups: catalog.groups,
  tools: catalog.tools.map((t) => ({
    id: t.id, group: t.group, name: t.name, what: t.what, speed: t.speed || '',
    skill: t.skill || '', repo: t.repo || '', status: t.status || '',
    styles: t.styles.map((s) => ({ id: s.id, name: s.name, example: s.example || null })),
  })),
};
fs.writeFileSync(path.join(HERE, 'styles.json'), JSON.stringify(styles, null, 1) + '\n');

const count = styles.tools.reduce((n, t) => n + t.styles.length, 0);
console.log(`web: ${copies.length} shared files copied, styles.json has ${styles.tools.length} tools / ${count} styles`);
