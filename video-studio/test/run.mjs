#!/usr/bin/env node
// Runs every test file explicitly, so `npm test` works on Windows and on Node 20
// (which cannot take a folder or a glob for --test).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f));
if (!files.length) { console.error('no test files found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
