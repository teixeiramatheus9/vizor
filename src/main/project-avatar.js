import path from 'node:path';

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
const GITHUB_REMOTE = /^(?:https?:\/\/(?:[^@/\s]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/[^/\s]+$/;

// Only github.com remotes have an owner avatar; anything else is null.
export function avatarOwnerOf(remoteUrl) {
  const match = String(remoteUrl ?? '').trim().match(GITHUB_REMOTE);
  return match && OWNER.test(match[1]) ? match[1] : null;
}

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
  return {
    // What the disk already has: { uri, fresh }.
    async load(owner) {
      if (!OWNER.test(owner)) return { uri: null, fresh: false };
      try {
        const [bytes, stat] = await Promise.all([fsp.readFile(fileOf(owner)), fsp.stat(fileOf(owner))]);
        const uri = toDataUri(bytes);
        return { uri, fresh: uri !== null && isAvatarFresh(stat.mtimeMs, now()) };
      } catch {
        return { uri: null, fresh: false };
      }
    },
    // Download, validate, cache. Resolves the new data URI, or null on any failure.
    async refresh(owner) {
      if (!OWNER.test(owner)) return null;
      try {
        const { contentType, bytes } = await fetchImage(`https://github.com/${owner}.png?size=64`);
        if (!acceptDownload(contentType, bytes)) return null;
        await fsp.mkdir(dir, { recursive: true });
        const tmp = `${fileOf(owner)}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, bytes);
        await fsp.rename(tmp, fileOf(owner));
        return toDataUri(bytes);
      } catch {
        return null;
      }
    },
  };
}
