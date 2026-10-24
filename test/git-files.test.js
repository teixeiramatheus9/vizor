import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readIndexVersion } from '../src/main/git-files.js';

describe('readIndexVersion', () => {
  let repo;
  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'cm-git-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo });
    git('init', '-q');
    await writeFile(path.join(repo, 'a b.txt'), 'v1');
    git('add', 'a b.txt');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    await writeFile(path.join(repo, 'a b.txt'), 'v2');
    await writeFile(path.join(repo, 'new.txt'), 'fresh');
  });

  it('reads the index version, not the working tree', async () => {
    expect(await readIndexVersion(path.join(repo, 'a b.txt'))).toBe('v1');
  });

  it('is null for an untracked file', async () => {
    expect(await readIndexVersion(path.join(repo, 'new.txt'))).toBeNull();
  });

  it('is null outside any repo', async () => {
    expect(await readIndexVersion(path.join(os.tmpdir(), 'nowhere-vizor', 'x.txt'))).toBeNull();
  });

  it('returns the index version with the checkout line endings', async () => {
    const crlf = await mkdtemp(path.join(os.tmpdir(), 'cm-git-crlf-'));
    const git = (...args) => execFileSync('git', args, { cwd: crlf });
    git('init', '-q');
    await writeFile(path.join(crlf, '.gitattributes'), '*.txt text eol=crlf\n');
    await writeFile(path.join(crlf, 'w.txt'), 'a\r\nb\r\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    expect(await readIndexVersion(path.join(crlf, 'w.txt'))).toBe('a\r\nb\r\n');
  });
});
