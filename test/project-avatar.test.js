import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  acceptDownload,
  avatarOwnerOf,
  createAvatarService,
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
    expect(avatarOwnerOf('')).toBeNull();
    expect(avatarOwnerOf(null)).toBeNull();
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
    async stat(p) { if (!(p in files)) throw new Error('ENOENT'); return { mtimeMs: files[p].mtimeMs }; },
    async mkdir() {},
    async writeFile(p, bytes) { files[p] = { bytes, mtimeMs: 1000 }; },
    async rename(a, b) { files[b] = files[a]; delete files[a]; },
  };
}

describe('createAvatarService', () => {
  it('loads the cache and reports freshness', async () => {
    const fsp = memoryFs({ '/c/acme.png': { bytes: PNG, mtimeMs: 900 } });
    const service = createAvatarService({ dir: '/c', fetchImage: async () => { throw new Error('no'); }, fsp, now: () => 1000 });
    const { uri, fresh } = await service.load('acme');
    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(fresh).toBe(true);
  });
  it('refresh writes the cache and returns the uri', async () => {
    const fsp = memoryFs();
    let url;
    const service = createAvatarService({ dir: '/c', fetchImage: async (u) => { url = u; return { contentType: 'image/png', bytes: PNG }; }, fsp });
    expect(await service.refresh('acme')).toMatch(/^data:image\/png/);
    expect(url).toBe('https://github.com/acme.png?size=64');
    expect(fsp.files['/c/acme.png'].bytes).toEqual(PNG);
  });
  it('keeps the old file when the download fails or is invalid', async () => {
    const fsp = memoryFs({ '/c/acme.png': { bytes: PNG, mtimeMs: 1 } });
    const failing = createAvatarService({ dir: '/c', fetchImage: async () => { throw new Error('offline'); }, fsp });
    expect(await failing.refresh('acme')).toBeNull();
    const bogus = createAvatarService({ dir: '/c', fetchImage: async () => ({ contentType: 'text/html', bytes: Buffer.from('x') }), fsp });
    expect(await bogus.refresh('acme')).toBeNull();
    expect(fsp.files['/c/acme.png'].bytes).toEqual(PNG);
  });
  it('refuses owners that are not plain logins', async () => {
    const service = createAvatarService({ dir: '/c', fetchImage: async () => ({}), fsp: memoryFs() });
    expect(await service.refresh('../x')).toBeNull();
    expect((await service.load('../x')).uri).toBeNull();
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
