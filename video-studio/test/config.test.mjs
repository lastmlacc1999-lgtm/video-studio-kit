import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveConfig, publicConfig, saveConfig, previewConfig, clearApiKey,
  normalizeProvider, describeConfig, DEFAULTS,
} from '../llm/config.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-config-')), 'llm.config.json');

test('defaults to Claude Code, exactly like before', () => {
  const cfg = resolveConfig({ file: {}, env: {} });
  assert.equal(cfg.provider, 'claude');
  assert.equal(cfg.scriptModel, 'sonnet');
  assert.equal(cfg.buildModel, 'opus');
  assert.equal(describeConfig(cfg), 'Claude Code · opus');
});

test('provider aliases map to the four backends', () => {
  assert.equal(normalizeProvider('gguf'), 'local');
  assert.equal(normalizeProvider('ollama'), 'local');
  assert.equal(normalizeProvider('google'), 'gemini');
  assert.equal(normalizeProvider('gpt'), 'openai');
  assert.equal(normalizeProvider('anthropic'), 'claude');
  assert.equal(normalizeProvider('nonsense', 'claude'), 'claude');
});

test('environment overrides the saved file', () => {
  const cfg = resolveConfig({
    file: { provider: 'openai', apiKey: 'file-key', scriptModel: 'gpt-file' },
    env: { VS_PROVIDER: 'gemini', GEMINI_API_KEY: 'env-key', VS_SCRIPT_MODEL: 'gemini-test' },
  });
  assert.equal(cfg.provider, 'gemini');
  assert.equal(cfg.apiKey, 'env-key');
  assert.equal(cfg.scriptModel, 'gemini-test');
  assert.equal(cfg.buildModel, 'gemini-2.5-pro'); // preset default for the purpose
  assert.equal(cfg.baseUrl, 'https://generativelanguage.googleapis.com');
});

test('provider-specific key env vars are picked up per provider', () => {
  const gemini = resolveConfig({ file: { provider: 'gemini' }, env: { GOOGLE_API_KEY: 'goog' } });
  assert.equal(gemini.apiKey, 'goog');
  assert.equal(gemini.apiKeyFromEnv, 'GOOGLE_API_KEY');
  const openai = resolveConfig({ file: { provider: 'openai' }, env: { OPENAI_API_KEY: 'sk-test' } });
  assert.equal(openai.apiKey, 'sk-test');
});

test('VS_API_KEY beats a provider-specific key and is reported as such', () => {
  const cfg = resolveConfig({ file: { provider: 'gemini', apiKey: 'saved' }, env: { VS_API_KEY: 'explicit', GEMINI_API_KEY: 'provider' } });
  assert.equal(cfg.apiKey, 'explicit');
  assert.equal(cfg.apiKeyFromEnv, 'VS_API_KEY');
});

test('local GGUF defaults to llama.cpp on the configured port', () => {
  const cfg = resolveConfig({ file: { provider: 'local', localPort: 9090, ggufPath: '/models/x.gguf' }, env: {} });
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:9090/v1');
  assert.equal(cfg.provider, 'local');
  assert.equal(cfg.ggufPath, '/models/x.gguf');
  assert.match(describeConfig(cfg), /x\.gguf/);
});

test('local runtime picks the right default ports', () => {
  assert.equal(resolveConfig({ file: { provider: 'local', localRuntime: 'ollama' }, env: {} }).baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(resolveConfig({ file: { provider: 'local', localRuntime: 'lmstudio' }, env: {} }).baseUrl, 'http://127.0.0.1:1234/v1');
});

test('an explicit base URL always wins (OpenRouter, vLLM, a remote llama.cpp)', () => {
  const cfg = resolveConfig({ file: { provider: 'openai', baseUrl: 'http://box:8000/v1' }, env: {} });
  assert.equal(cfg.baseUrl, 'http://box:8000/v1');
  assert.equal(cfg.baseUrlExplicit, true);
});

test('publicConfig never leaks the key', () => {
  const cfg = resolveConfig({ file: { provider: 'openai', apiKey: 'sk-secret-value' }, env: {} });
  const pub = publicConfig(cfg, { env: {} });
  assert.equal(pub.hasApiKey, true);
  assert.equal(JSON.stringify(pub).includes('sk-secret-value'), false);
  assert.equal(pub.ready, true);
  assert.ok(Array.isArray(pub.providers) && pub.providers.length === 4);
});

test('saveConfig keeps a saved key when the form sends an empty one', () => {
  const file = tmpFile();
  saveConfig({ provider: 'openai', apiKey: 'sk-1' }, { file });
  const cfg = saveConfig({ provider: 'openai', apiKey: '' }, { file });
  assert.equal(cfg.apiKey, 'sk-1');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, 'sk-1');
});

test('saveConfig writes the file private and clearApiKey removes only the secret', () => {
  const file = tmpFile();
  saveConfig({ provider: 'gemini', apiKey: 'g-1', scriptModel: 'gemini-2.5-flash' }, { file });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  clearApiKey({ file });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.apiKey, undefined);
  assert.equal(saved.provider, 'gemini');
  assert.equal(saved.scriptModel, 'gemini-2.5-flash');
});

test('previewConfig merges an unsaved patch without writing', () => {
  const file = tmpFile();
  saveConfig({ provider: 'claude' }, { file });
  const before = fs.readFileSync(file, 'utf8');
  const cfg = previewConfig({ provider: 'openai', apiKey: 'sk-preview', baseUrl: 'http://127.0.0.1:9/v1' }, { file, env: {} });
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-preview');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('tool mode and numbers are normalised', () => {
  const cfg = resolveConfig({ file: { toolMode: 'weird', maxSteps: '0', ctxSize: -5 }, env: {} });
  assert.equal(cfg.toolMode, 'auto');
  assert.equal(cfg.maxSteps, DEFAULTS.maxSteps);
  assert.equal(cfg.ctxSize, DEFAULTS.ctxSize);
});

test('switching provider drops the old provider’s url and model names', () => {
  const file = tmpFile();
  saveConfig({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', scriptModel: 'gpt-4.1-mini', buildModel: 'gpt-4.1' }, { file });
  const cfg = saveConfig({ provider: 'local', ggufPath: '/m/x.gguf' }, { file });
  assert.equal(cfg.provider, 'local');
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(cfg.scriptModel, 'local');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.baseUrl, undefined);
  assert.equal(saved.scriptModel, undefined);
});

test('a key belonging to the old provider is not carried over', () => {
  const file = tmpFile();
  saveConfig({ provider: 'openai', apiKey: 'sk-openai' }, { file });
  const local = saveConfig({ provider: 'local' }, { file });
  assert.equal(local.apiKey, '');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, undefined);
  const gemini = saveConfig({ provider: 'gemini', apiKey: 'g-new' }, { file });
  assert.equal(gemini.apiKey, 'g-new');
});
