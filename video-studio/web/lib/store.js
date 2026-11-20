// Browser storage: model settings + API keys in localStorage/sessionStorage, projects in
// IndexedDB (falling back to localStorage when a browser blocks it). Nothing is sent anywhere.
import { PROVIDERS } from './providers.js';

const SETTINGS_KEY = 'vsb.settings.v1';
const KEY_PREFIX = 'vsb.key.';
const LAST_KEY = 'vsb.lastProject.v1';
const FALLBACK_KEY = 'vsb.projects.v1';
const DB_NAME = 'video-studio-browser';
const DB_STORE = 'projects';

export const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

export const defaultSettings = () => ({
  provider: 'gemini',
  rememberKey: true,
  studioUrl: '',
  profiles: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { model: p.model, baseUrl: p.baseUrl }])),
});

export function loadSettings() {
  const base = defaultSettings();
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return base;
    const merged = { ...base, ...raw, profiles: { ...base.profiles } };
    for (const id of Object.keys(base.profiles)) merged.profiles[id] = { ...base.profiles[id], ...(raw.profiles?.[id] || {}) };
    if (!PROVIDERS[merged.provider]) merged.provider = base.provider;
    merged.rememberKey = merged.rememberKey !== false;
    return merged;
  } catch {
    return base;
  }
}

export function saveSettings(settings) {
  const clean = {
    provider: settings.provider,
    rememberKey: settings.rememberKey !== false,
    studioUrl: String(settings.studioUrl || '').trim(),
    profiles: settings.profiles || {},
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean));
  return clean;
}

/** A key saved in this browser (localStorage if remembered, otherwise the current tab's session). */
export function getKey(provider) {
  try { return localStorage.getItem(KEY_PREFIX + provider) || sessionStorage.getItem(KEY_PREFIX + provider) || ''; }
  catch { return ''; }
}

export function setKey(provider, key, remember) {
  const k = String(key || '');
  try {
    localStorage.removeItem(KEY_PREFIX + provider);
    sessionStorage.removeItem(KEY_PREFIX + provider);
    if (!k) return;
    (remember ? localStorage : sessionStorage).setItem(KEY_PREFIX + provider, k);
  } catch { /* storage disabled */ }
}

export function forgetKey(provider) {
  try { localStorage.removeItem(KEY_PREFIX + provider); sessionStorage.removeItem(KEY_PREFIX + provider); } catch { /* ignore */ }
}

export const lastProjectId = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; } };
export const setLastProjectId = (id) => { try { localStorage.setItem(LAST_KEY, id || ''); } catch { /* ignore */ } };

// ---------- projects ----------
let dbPromise = null;
function openDb() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB is not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

async function idbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(project) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(project);
    tx.oncomplete = () => resolve(project);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function fallbackAll() {
  try { return JSON.parse(localStorage.getItem(FALLBACK_KEY) || '[]'); } catch { return []; }
}
function fallbackWrite(rows) {
  try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(rows)); } catch { /* ignore */ }
}

export async function listProjects() {
  try {
    const rows = await idbAll();
    return rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } catch {
    return fallbackAll().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
}

export async function getProject(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return fallbackAll().find((p) => p.id === id) || null;
  }
}

export async function putProject(project) {
  const row = { ...project, updatedAt: new Date().toISOString() };
  try { return await idbPut(row); } catch {
    const rows = fallbackAll();
    const i = rows.findIndex((p) => p.id === row.id);
    if (i >= 0) rows[i] = row; else rows.push(row);
    fallbackWrite(rows);
    return row;
  }
}

export async function deleteProject(id) {
  try { await idbDelete(id); return true; } catch {
    fallbackWrite(fallbackAll().filter((p) => p.id !== id));
    return true;
  }
}
