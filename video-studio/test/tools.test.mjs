import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createToolkit, resolveInRoots } from '../llm/tools.mjs';
import { tempDir } from './helpers.mjs';

function setup() {
  const dir = tempDir();
  const project = path.join(dir, 'project');
  const build = path.join(dir, 'build');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(build, { recursive: true });
  return { dir, project, build, kit: createToolkit({ cwd: project, roots: [project, build] }) };
}

test('write, read, edit and list files inside the project', async () => {
  const { project, kit } = setup();
  let r = await kit.run('write_file', { path: 'src/scene.js', content: 'const a = 1;\nconst b = 2;\n' });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(project, 'src/scene.js')));

  r = await kit.run('read_file', { path: 'src/scene.js' });
  assert.equal(r.ok, true);
  assert.match(r.output, /1→const a = 1;/);
  assert.match(r.output, /3 lines total/);

  r = await kit.run('edit_file', { path: 'src/scene.js', old_text: 'const b = 2;', new_text: 'const b = 3;' });
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(path.join(project, 'src/scene.js'), 'utf8'), /b = 3/);

  r = await kit.run('list_files', { pattern: '**/*.js' });
  assert.equal(r.ok, true);
  assert.match(r.output, /src\/scene\.js/);
});

test('edit_file refuses ambiguous or missing matches', async () => {
  const { kit } = setup();
  await kit.run('write_file', { path: 'dup.txt', content: 'x\nx\n' });
  let r = await kit.run('edit_file', { path: 'dup.txt', old_text: 'x', new_text: 'y' });
  assert.equal(r.ok, false);
  assert.match(r.output, /more than one place/);
  r = await kit.run('edit_file', { path: 'dup.txt', old_text: 'nope', new_text: 'y' });
  assert.equal(r.ok, false);
  assert.match(r.output, /not found/);
});

test('the jail stops writes and commands outside the project', async () => {
  const { dir, kit } = setup();
  let r = await kit.run('write_file', { path: '../escape.txt', content: 'no' });
  assert.equal(r.ok, false);
  assert.match(r.output, /refusing to touch/);
  assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);

  r = await kit.run('read_file', { path: path.join(dir, 'secret.txt') });
  assert.equal(r.ok, false);
  assert.match(r.output, /refusing to touch/);

  r = await kit.run('bash', { command: 'echo hi', cwd: '../' });
  assert.equal(r.ok, false);

  assert.throws(() => resolveInRoots('/etc/passwd', { cwd: dir, roots: [path.join(dir, 'project')] }), /refusing/);
});

test('bash runs commands and reports failures', async () => {
  const { kit } = setup();
  let r = await kit.run('bash', { command: 'echo hello-from-toolkit' });
  assert.equal(r.ok, true);
  assert.match(r.output, /hello-from-toolkit/);

  r = await kit.run('bash', { command: 'node -e "process.exit(3)"' });
  assert.equal(r.ok, false);
  assert.match(r.output, /exit code 3|command failed/);
});

test('grep finds text and ignores binary files', async () => {
  const { project, kit } = setup();
  fs.writeFileSync(path.join(project, 'a.txt'), 'alpha\nbeta needle\n');
  fs.writeFileSync(path.join(project, 'b.bin'), Buffer.from([0, 1, 2, 3]));
  const r = await kit.run('grep', { pattern: 'needle' });
  assert.equal(r.ok, true);
  assert.match(r.output, /a\.txt:2/);
  assert.doesNotMatch(r.output, /b\.bin/);
});

test('unknown tools fail politely', async () => {
  const { kit } = setup();
  const r = await kit.run('rm_rf', {});
  assert.equal(r.ok, false);
  assert.match(r.output, /unknown tool/);
});

test('a symlink cannot be used to escape the sandbox', { skip: process.platform === 'win32' }, async () => {
  const { project, kit } = setup();
  const outside = tempDir('vs-outside-');
  fs.symlinkSync(outside, path.join(project, 'escape'), 'dir');
  const r = await kit.run('write_file', { path: 'escape/evil.txt', content: 'no' });
  assert.equal(r.ok, false);
  assert.match(r.output, /refusing to touch/);
  assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false);
});
