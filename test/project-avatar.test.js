import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  acceptDownload,
  avatarOwnerOf,
  repoRefOf,
  resolveLogo,
  parseOpenGraph,
  openGraphArgs,
  createAvatarService,
  nextAvatarCheck,
  avatarCheckDue,
  AVATAR_CHECK_EVERY_MS,
  isAvatarFresh,
  AVATAR_MAX_AGE_MS,
} from '../src/main/project-avatar.js';
import { fetchImage } from '../src/main/avatar-fetch.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('avatarOwnerOf', () => {
  it('reads the owner of github.com remotes', () => {
    expect(avatarOwnerOf('https://github.com/teixeiramatheus9/vizor.git')).toBe('teixeiramatheus9');
    expect(avatarOwnerOf('git@github.com:acme/app.git\n')).toBe('acme');
    expect(avatarOwnerOf('ssh://git@github.com/acme/app')).toBe('acme');
  });
  it('ignores other hosts and odd owners', () => {
    expect(avatarOwnerOf('https://gitlab.com/acme/app.git')).toBeNull();
    expect(avatarOwnerOf('https://evilgithub.com/acme/app.git')).toBeNull();
    expect(avatarOwnerOf('https://github.com/../app.git')).toBeNull();
    expect(avatarOwnerOf('https://github.com/acme/app/')).toBe('acme');
    expect(avatarOwnerOf('')).toBeNull();
    expect(avatarOwnerOf(null)).toBeNull();
  });
});

describe('avatarCheckDue', () => {
  const entry = (over = {}) => ({ busy: false, nextCheck: 0, ...over });
  it('reads a project the first time even with the window hidden', () => {
    expect(avatarCheckDue(entry(), { now: 5, hidden: true })).toBe(true);
  });
  it('re-checks only when due, not busy and with the window on screen', () => {
    expect(avatarCheckDue(entry({ nextCheck: 10 }), { now: 20, hidden: false })).toBe(true);
    expect(avatarCheckDue(entry({ nextCheck: 10 }), { now: 20, hidden: true })).toBe(false);
    expect(avatarCheckDue(entry({ nextCheck: 30 }), { now: 20, hidden: false })).toBe(false);
    expect(avatarCheckDue(entry({ busy: true }), { now: 20, hidden: false })).toBe(false);
  });
});

describe('nextAvatarCheck', () => {
  it('looks again after the backoff', () => {
    expect(nextAvatarCheck(1000)).toBe(1000 + AVATAR_CHECK_EVERY_MS);
    expect(AVATAR_CHECK_EVERY_MS).toBe(10 * 60 * 1000);
  });
});

describe('isAvatarFresh', () => {
  const now = 10 * AVATAR_MAX_AGE_MS;
  it('trusts a file younger than a week', () => {
    expect(isAvatarFresh(now - 1000, now)).toBe(true);
    expect(isAvatarFresh(now - AVATAR_MAX_AGE_MS - 1, now)).toBe(false);
  });
  it('distrusts future or missing mtimes', () => {
    expect(isAvatarFresh(now + 5000, now)).toBe(false);
    expect(isAvatarFresh(undefined, now)).toBe(false);
  });
});

describe('acceptDownload', () => {
  it('accepts a small png', () => expect(acceptDownload('image/png; charset=x', PNG)).toBe(true));
  it('rejects wrong type, wrong bytes and oversize', () => {
    expect(acceptDownload('text/html', PNG)).toBe(false);
    expect(acceptDownload('image/png', Buffer.from('<html>'))).toBe(false);
    expect(acceptDownload('image/png', Buffer.concat([PNG, Buffer.alloc(512 * 1024)]))).toBe(false);
  });
});

function memoryFs(files = {}) {
  return {
    files,
    async readFile(p) { if (!(p in files)) throw new Error('ENOENT'); return files[p].bytes; },
    async stat(p) { if (!(p in files)) throw new Error('ENOENT'); return { mtimeMs: files[p].mtimeMs, size: files[p].bytes.length }; },
    async mkdir() {},
    async writeFile(p, bytes) { files[p] = { bytes, mtimeMs: 1000 }; },
    async rename(a, b) { files[b] = files[a]; delete files[a]; },
  };
}

const REF = { owner: 'acme', name: 'app' };
const OG_URL = 'https://repository-images.githubusercontent.com/1/abc';
const gql = (custom) => JSON.stringify({ data: { repository: { usesCustomOpenGraphImage: custom, openGraphImageUrl: custom ? OG_URL : 'https://opengraph.githubassets.com/x/acme/app' } } });

describe('repoRefOf', () => {
  it('reads owner and name of github.com remotes', () => {
    expect(repoRefOf('https://github.com/acme/app.git')).toEqual(REF);
    expect(repoRefOf('git@github.com:acme/app.git\n')).toEqual(REF);
  });
  it('is null for other hosts, odd names and no remote', () => {
    expect(repoRefOf('https://gitlab.com/acme/app.git')).toBeNull();
    expect(repoRefOf('https://github.com/acme/..')).toBeNull();
    expect(repoRefOf('')).toBeNull();
  });
});

describe('parseOpenGraph / openGraphArgs', () => {
  it('returns the url only for a custom social preview', () => {
    expect(parseOpenGraph(gql(true))).toBe(OG_URL);
    expect(parseOpenGraph(gql(false))).toBeNull();
  });
  it('is null for junk, non-https and errors', () => {
    expect(parseOpenGraph('nope')).toBeNull();
    expect(parseOpenGraph(JSON.stringify({ errors: [{}] }))).toBeNull();
    expect(parseOpenGraph(JSON.stringify({ data: { repository: { usesCustomOpenGraphImage: true, openGraphImageUrl: 'http://x/y' } } }))).toBeNull();
  });
  it('passes owner and name as plain strings', () => {
    const args = openGraphArgs({ owner: 'acme', name: '123' });
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('n=123');
    expect(args).not.toContain('-F');
  });
});

function service(over = {}) {
  const requested = [];
  const fsp = over.fsp ?? memoryFs();
  const svc = createAvatarService({
    dir: '/c',
    fsp,
    now: over.now,
    queryOpenGraph: over.queryOpenGraph ?? (async () => OG_URL),
    fetchImage: over.fetchImage ?? (async (url) => { requested.push(url); return { contentType: 'image/png', bytes: PNG }; }),
  });
  return { svc, fsp, requested };
}

describe('createAvatarService', () => {
  it('loads the cache and reports freshness', async () => {
    const fsp = memoryFs({ '/c/og-acme@app.img': { bytes: PNG, mtimeMs: 900 } });
    const { svc } = service({ fsp, now: () => 1000 });
    const { uri, fresh } = await svc.load(REF);
    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(fresh).toBe(true);
  });
  it('refresh downloads the custom preview, caches it and never asks for the owner avatar', async () => {
    const { svc, fsp, requested } = service();
    expect((await svc.refresh(REF)).uri).toMatch(/^data:image\/png/);
    expect(requested).toEqual([OG_URL]);
    expect(requested.join()).not.toMatch(/github\.com\/acme\.png/);
    expect(fsp.files['/c/og-acme@app.img'].bytes).toEqual(PNG);
  });
  it('a repo without a custom image requests nothing and drops the old cache', async () => {
    const fsp = memoryFs({ '/c/og-acme@app.img': { bytes: PNG, mtimeMs: 1 } });
    fsp.unlink = async (p) => { delete fsp.files[p]; };
    const { svc, requested } = service({ fsp, queryOpenGraph: async () => null });
    expect(await svc.refresh(REF)).toEqual({ uri: null });
    expect(requested).toEqual([]);
    expect(fsp.files['/c/og-acme@app.img']).toBeUndefined();
  });
  it('shares one in-flight download per repo and never reuses a tmp name', async () => {
    const fsp = memoryFs();
    const writes = [];
    const realWrite = fsp.writeFile;
    fsp.writeFile = async (p, b) => { writes.push(p); await new Promise((r) => setTimeout(r, 5)); return realWrite(p, b); };
    let fetches = 0;
    const { svc } = service({ fsp, fetchImage: async () => { fetches += 1; return { contentType: 'image/png', bytes: PNG }; } });
    const [a, b] = await Promise.all([svc.refresh(REF), svc.refresh(REF)]);
    expect(a).toBe(b);
    expect(fetches).toBe(1);
    await svc.refresh(REF);
    expect(new Set(writes).size).toBe(writes.length);
  });
  it('accepts up to 1 MB but not more', async () => {
    const ok = Buffer.concat([PNG, Buffer.alloc(700 * 1024)]);
    expect((await service({ fetchImage: async () => ({ contentType: 'image/png', bytes: ok }) }).svc.refresh(REF)).uri).toMatch(/^data:/);
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    expect(await service({ fetchImage: async () => ({ contentType: 'image/png', bytes: big }) }).svc.refresh(REF)).toEqual({ failed: true });
  });
  it('keeps the old file when gh, the download or the bytes fail', async () => {
    const fsp = memoryFs({ '/c/og-acme@app.img': { bytes: PNG, mtimeMs: 1 } });
    for (const over of [
      { queryOpenGraph: async () => { throw new Error('no gh'); } },
      { fetchImage: async () => { throw new Error('offline'); } },
      { fetchImage: async () => ({ contentType: 'text/html', bytes: Buffer.from('x') }) },
    ]) expect(await service({ fsp, ...over }).svc.refresh(REF)).toEqual({ failed: true });
    expect(fsp.files['/c/og-acme@app.img'].bytes).toEqual(PNG);
  });
  it('refuses refs that are not plain names', async () => {
    const { svc } = service();
    expect(await svc.refresh({ owner: '../x', name: 'a' })).toEqual({ failed: true });
    expect(await svc.refresh({ owner: 'a', name: '..' })).toEqual({ failed: true });
    expect((await svc.load({ owner: '../x', name: 'a' })).uri).toBeNull();
  });
});

function fakeGet(routes) {
  return (url, _opts, cb) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    const route = routes[url.toString()];
    queueMicrotask(() => {
      if (!route) return request.emit('error', new Error('no route'));
      const response = new EventEmitter();
      response.statusCode = route.status;
      response.headers = route.headers ?? {};
      response.resume = () => {};
      response.destroy = () => {};
      cb(response);
      for (const chunk of route.chunks ?? []) response.emit('data', chunk);
      response.emit('end');
    });
    return request;
  };
}

describe('fetchImage', () => {
  it('follows a redirect to the avatar host', async () => {
    const get = fakeGet({
      'https://github.com/acme.png?size=64': { status: 302, headers: { location: 'https://avatars.githubusercontent.com/u/1?s=64' } },
      'https://avatars.githubusercontent.com/u/1?s=64': { status: 200, headers: { 'content-type': 'image/png' }, chunks: [PNG] },
    });
    const result = await fetchImage('https://github.com/acme.png?size=64', { get });
    expect(result.contentType).toBe('image/png');
    expect(result.bytes).toEqual(PNG);
  });
  it('refuses redirects to other hosts and oversized bodies', async () => {
    const away = fakeGet({
      'https://github.com/a.png': { status: 302, headers: { location: 'https://evil.example/x.png' } },
    });
    await expect(fetchImage('https://github.com/a.png', { get: away })).rejects.toThrow(/not allowed/);
    const big = fakeGet({ 'https://github.com/b.png': { status: 200, chunks: [Buffer.alloc(600 * 1024)] } });
    await expect(fetchImage('https://github.com/b.png', { get: big })).rejects.toThrow(/too large/);
  });
  it('rejects non-200 answers', async () => {
    const get = fakeGet({ 'https://github.com/c.png': { status: 404 } });
    await expect(fetchImage('https://github.com/c.png', { get })).rejects.toThrow(/404/);
  });
});

describe('resolveLogo', () => {
  const run = async ({ local = null, remote = 'https://github.com/acme/app.git', load = { uri: null, fresh: false }, refresh = { uri: 'og' } } = {}) => {
    const calls = [];
    const shown = [];
    await resolveLogo({
      findLocal: async () => local,
      getRemote: async () => { calls.push('remote'); return remote; },
      service: { load: async () => { calls.push('load'); return load; }, refresh: async () => { calls.push('refresh'); return refresh; } },
      show: (uri) => shown.push(uri),
    });
    return { calls, shown };
  };
  it('a local logo wins and touches neither git remote nor network', async () => {
    expect(await run({ local: 'local' })).toEqual({ calls: [], shown: ['local'] });
  });
  it('no local logo and no github remote: monogram, no gh', async () => {
    expect(await run({ remote: 'https://gitlab.com/a/b' })).toEqual({ calls: ['remote'], shown: [null] });
    expect(await run({ remote: '' })).toEqual({ calls: ['remote'], shown: [null] });
  });
  it('falls back to the custom social preview: cache first, then a refresh', async () => {
    expect(await run({ load: { uri: 'old', fresh: false } })).toEqual({ calls: ['remote', 'load', 'refresh'], shown: ['old', 'og'] });
  });
  it('a fresh cache is not refreshed', async () => {
    expect(await run({ load: { uri: 'old', fresh: true } })).toEqual({ calls: ['remote', 'load'], shown: ['old'] });
  });
  it('a repo with no custom image ends on the monogram; a failed refresh keeps the cache', async () => {
    expect((await run({ load: { uri: 'old', fresh: false }, refresh: { uri: null } })).shown).toEqual(['old', null]);
    expect((await run({ load: { uri: 'old', fresh: false }, refresh: { failed: true } })).shown).toEqual(['old']);
  });
});
