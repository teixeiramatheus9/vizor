import path from 'node:path';
import { githubRepoOf } from './voice/gh-digest.js';

// The GitHub owner's avatar next to each project in the workspace sidebar.
// Pure decisions and a small cache service live here; the network and the
// disk are injected (see avatar-fetch.js for the real downloader), so all of
// it is testable without either.

export const AVATAR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const AVATAR_MAX_BYTES = 512 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// GitHub logins: alphanumerics and single hyphens, up to 39 chars. The strict
// shape also keeps the owner safe to put in a URL and in a cache file name.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// githubRepoOf is unanchored on the host: this pins it to github.com itself.
const GITHUB_HOST = /^(?:https?:\/\/(?:[^@/\s]+@)?|ssh:\/\/git@|git@)github\.com[:/]/;

// Only github.com remotes have an owner avatar; anything else is null.
export function avatarOwnerOf(remoteUrl) {
  const remote = String(remoteUrl ?? '').trim();
  const owner = GITHUB_HOST.test(remote) ? githubRepoOf(remote)?.split('/')[0] : null;
  return owner && OWNER.test(owner) ? owner : null;
}

// How often a project's avatar is looked at again while the app stays open:
// the remote may have changed, a failed download is retried, a week-old file
// is refreshed. Also the backoff, so a push never means a request.
export const AVATAR_CHECK_EVERY_MS = 10 * 60 * 1000;
export const nextAvatarCheck = (now) => now + AVATAR_CHECK_EVERY_MS;

// A cached file is trusted for a week; a future mtime (clock skew) is not.
export function isAvatarFresh(mtimeMs, now, maxAge = AVATAR_MAX_AGE_MS) {
  if (!Number.isFinite(mtimeMs)) return false;
  const age = now - mtimeMs;
  return age >= 0 && age < maxAge;
}

export function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// A download is kept only when it declares an allowed image type, is small
// enough, and its bytes really are that kind of image.
export function acceptDownload(contentType, bytes) {
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(declared)) return false;
  if (!bytes?.length || bytes.length > AVATAR_MAX_BYTES) return false;
  return sniffImageType(bytes) !== null;
}

export function toDataUri(bytes) {
  const type = sniffImageType(bytes);
  return type ? `data:${type};base64,${bytes.toString('base64')}` : null;
}

// fsp: { readFile, writeFile, rename, mkdir, stat }; fetchImage(url) resolves
// { contentType, bytes } or rejects. A failed refresh keeps the old file.
export function createAvatarService({ dir, fetchImage, fsp, now = Date.now }) {
  const fileOf = (owner) => path.join(dir, `${owner}.png`);
  const inflight = new Map(); // owner -> Promise: projects of one owner share a download
  let counter = 0;
  return {
    // What the disk already has: { uri, fresh }.
    async load(owner) {
      if (!OWNER.test(owner)) return { uri: null, fresh: false };
      try {
        const stat = await fsp.stat(fileOf(owner));
        if (!(stat.size <= AVATAR_MAX_BYTES)) return { uri: null, fresh: false };
        const bytes = await fsp.readFile(fileOf(owner));
        const uri = toDataUri(bytes);
        return { uri, fresh: uri !== null && isAvatarFresh(stat.mtimeMs, now()) };
      } catch {
        return { uri: null, fresh: false };
      }
    },
    // Download, validate, cache. Resolves the new data URI, or null on any failure.
    refresh(owner) {
      if (!OWNER.test(owner)) return Promise.resolve(null);
      if (!inflight.has(owner)) inflight.set(owner, download(owner).finally(() => inflight.delete(owner)));
      return inflight.get(owner);
    },
  };

  async function download(owner) {
    try {
      const { contentType, bytes } = await fetchImage(`https://github.com/${owner}.png?size=64`);
      if (!acceptDownload(contentType, bytes)) return null;
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${fileOf(owner)}.${process.pid}.${++counter}.tmp`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, fileOf(owner));
      return toDataUri(bytes);
    } catch {
      return null;
    }
  }
}
