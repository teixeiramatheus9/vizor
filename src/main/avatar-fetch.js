import https from 'node:https';
import { AVATAR_MAX_BYTES } from './project-avatar.js';

// github.com/<owner>.png answers with a redirect to avatars.githubusercontent.com.
const trusted = (host) => host === 'github.com' || host.endsWith('.githubusercontent.com');

// Download one image: https only, GitHub hosts only, a few redirects, a hard
// timeout and a size cap. Resolves { contentType, bytes }. `get` is injectable.
export function fetchImage(url, { get = https.get, timeoutMs = 5000, maxBytes = AVATAR_MAX_BYTES, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    let current = null;
    const timer = setTimeout(() => {
      current?.destroy();
      finish(reject, new Error('avatar download timed out'));
    }, timeoutMs);

    const visit = (target, redirects) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return finish(reject, new Error('bad avatar url'));
      }
      if (parsed.protocol !== 'https:' || !trusted(parsed.hostname)) return finish(reject, new Error('avatar host not allowed'));
      current = get(parsed, { headers: { 'user-agent': 'vizor' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= maxRedirects) return finish(reject, new Error('too many redirects'));
          return visit(new URL(response.headers.location, parsed).toString(), redirects + 1);
        }
        if (status !== 200) {
          response.resume();
          return finish(reject, new Error(`avatar status ${status}`));
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            return finish(reject, new Error('avatar too large'));
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(resolve, { contentType: response.headers['content-type'] ?? '', bytes: Buffer.concat(chunks) }));
        response.on('error', (error) => finish(reject, error));
      });
      current.on('error', (error) => finish(reject, error));
    };
    visit(url, 0);
  });
}
