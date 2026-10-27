import path from 'node:path';
import { githubRepoOf } from './voice/gh-digest.js';

// The picture next to each project in the workspace sidebar: a logo inside the
// project (local-logo.js), else the repo's custom GitHub social preview, else
// a monogram. Never the owner's profile photo. Pure decisions and a small
// cache service live here; the network and the disk are injected (see
// avatar-fetch.js for the real downloader), so all of it is testable without
// either.

export const AVATAR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const AVATAR_MAX_BYTES = 512 * 1024;
// A social preview is 1280x640: allowed a bigger file than a logo.
export const OG_MAX_BYTES = 1024 * 1024;
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

const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

// { owner, name } of a github.com remote, both strictly validated; else null.
export function repoRefOf(remoteUrl) {
  const owner = avatarOwnerOf(remoteUrl);
  const name = owner ? githubRepoOf(String(remoteUrl).trim())?.split('/')[1] : null;
  return owner && name && REPO_NAME.test(name) ? { owner, name } : null;
}

export const OPEN_GRAPH_QUERY =
  'query($o:String!,$n:String!){repository(owner:$o,name:$n){usesCustomOpenGraphImage openGraphImageUrl}}';

// `gh api graphql` argv. -f (not -F) so an all-digits name stays a string.
export const openGraphArgs = ({ owner, name }) => ['api', 'graphql', '-f', `query=${OPEN_GRAPH_QUERY}`, '-f', `o=${owner}`, '-f', `n=${name}`];

// The social preview URL only when the repo set its own (GitHub otherwise
// serves a generated card); https only. null otherwise.
export function parseOpenGraph(text) {
  try {
    const repo = JSON.parse(text)?.data?.repository;
    const url = repo?.usesCustomOpenGraphImage === true ? repo.openGraphImageUrl : null;
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

// How often a project's avatar is looked at again while the app stays open:
// the remote may have changed, a failed download is retried, a week-old file
// is refreshed. Also the backoff, so a push never means a request.
export const AVATAR_CHECK_EVERY_MS = 10 * 60 * 1000;
export const nextAvatarCheck = (now) => now + AVATAR_CHECK_EVERY_MS;

// entry: { busy, nextCheck } (nextCheck 0 = never read). The first read always
// runs, so the avatar shows; the periodic re-checks wait for the window.
export const avatarCheckDue = (entry, { now, hidden }) => !entry.busy && now >= entry.nextCheck && !(entry.nextCheck && hidden);

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
export function acceptDownload(contentType, bytes, maxBytes = AVATAR_MAX_BYTES) {
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(declared)) return false;
  if (!bytes?.length || bytes.length > maxBytes) return false;
  return sniffImageType(bytes) !== null;
}

export function toDataUri(bytes) {
  const type = sniffImageType(bytes);
  return type ? `data:${type};base64,${bytes.toString('base64')}` : null;
}

// fsp: { readFile, writeFile, rename, mkdir, stat, unlink }; queryOpenGraph(ref)
// resolves the custom preview URL or null (rejects when gh fails);
// fetchImage(url) resolves { contentType, bytes } or rejects. A failed
// refresh keeps the old file; "this repo has no custom image" removes it.
// The only image URL ever requested is the one GitHub names for the repo.
export function createAvatarService({ dir, fetchImage, queryOpenGraph, fsp, now = Date.now }) {
  const fileOf = (ref) => path.join(dir, `og-${ref.owner}@${ref.name}.img`);
  const valid = (ref) => Boolean(ref && OWNER.test(ref.owner) && REPO_NAME.test(ref.name));
  const inflight = new Map();
  let counter = 0;
  return {
    // What the disk already has: { uri, fresh }.
    async load(ref) {
      if (!valid(ref)) return { uri: null, fresh: false };
      try {
        const stat = await fsp.stat(fileOf(ref));
        if (!(stat.size <= OG_MAX_BYTES)) return { uri: null, fresh: false };
        const uri = toDataUri(await fsp.readFile(fileOf(ref)));
        return { uri, fresh: uri !== null && isAvatarFresh(stat.mtimeMs, now()) };
      } catch {
        return { uri: null, fresh: false };
      }
    },
    // Resolves { uri } (null = the repo has no custom image) or { failed: true }.
    refresh(ref) {
      if (!valid(ref)) return Promise.resolve({ failed: true });
      const key = fileOf(ref);
      if (!inflight.has(key)) inflight.set(key, download(ref).finally(() => inflight.delete(key)));
      return inflight.get(key);
    },
  };

  async function download(ref) {
    try {
      const url = await queryOpenGraph(ref);
      if (!url) {
        await fsp.unlink?.(fileOf(ref)).catch(() => {});
        return { uri: null };
      }
      const { contentType, bytes } = await fetchImage(url);
      if (!acceptDownload(contentType, bytes, OG_MAX_BYTES)) return { failed: true };
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${fileOf(ref)}.${process.pid}.${++counter}.tmp`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, fileOf(ref));
      return { uri: toDataUri(bytes) };
    } catch {
      return { failed: true };
    }
  }
}

// The decision order for one project: its own logo, else the repo's custom
// social preview (cache first, refreshed when stale), else nothing (monogram).
// getRemote is only called when there is no local logo; the service is only
// touched when the project has a github.com remote.
export async function resolveLogo({ findLocal, getRemote, service, show }) {
  const local = await findLocal();
  if (local) return show(local);
  const ref = repoRefOf(await getRemote());
  if (!ref) return show(null);
  const cached = await service.load(ref);
  show(cached.uri);
  if (cached.fresh) return;
  const result = await service.refresh(ref);
  if (!result.failed) show(result.uri);
}
