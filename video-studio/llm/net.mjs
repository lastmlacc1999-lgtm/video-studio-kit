// Node's built-in fetch ignores HTTP(S)_PROXY. The studio already ships undici (for the same
// reason), so when a proxy is configured we borrow it — best effort, never required.
import path from 'node:path';
import { createRequire } from 'node:module';
import { BUILD_DIR } from './config.mjs';

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i;
let cached = null;

export function proxyFetch() {
  if (cached) return cached;
  cached = globalThis.fetch;
  const env = process.env;
  const hasProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!hasProxy) return cached;
  try {
    const require = createRequire(path.join(BUILD_DIR, 'studio', 'package.json'));
    const undici = require('undici');
    const dispatcher = new undici.EnvHttpProxyAgent();
    cached = (url, opts = {}) => {
      // never send local model traffic through a corporate proxy
      let host = '';
      try { host = new URL(String(url)).hostname; } catch { /* relative */ }
      if (LOCAL_HOSTS.test(host)) return globalThis.fetch(url, opts);
      return undici.fetch(url, { ...opts, dispatcher });
    };
  } catch {
    cached = globalThis.fetch; // undici not installed: still works, just without proxy support
  }
  return cached;
}
