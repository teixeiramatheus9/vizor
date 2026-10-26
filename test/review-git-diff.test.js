import { describe, it, expect } from 'vitest';
import {
  baseCandidates,
  parseNumstatZ,
  parseUnifiedDiff,
  hunkId,
  markCommitted,
  untrackedAsFiles,
} from '../src/main/review/git-diff.js';

const TWO_FILES = `diff --git a/src/a.js b/src/a.js
index 111..222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@ function x() {
 ten
+eleven
 twelve
diff --git a/src/b.js b/src/b.js
index 333..444 100644
--- a/src/b.js
+++ b/src/b.js
@@ -5 +5 @@
-old
+new
\\ No newline at end of file
`;

describe('parseUnifiedDiff', () => {
  it('reads two files and three hunks with line numbers', () => {
    const files = parseUnifiedDiff(TWO_FILES);
    expect(files.map((f) => f.path)).toEqual(['src/a.js', 'src/b.js']);
    expect(files.map((f) => f.hunks.length)).toEqual([2, 1]);
    const [h1, h2] = files[0].hunks;
    expect([h1.oldStart, h1.oldLines, h1.newStart, h1.newLines]).toEqual([1, 3, 1, 3]);
    expect(h1.lines).toEqual([
      { kind: ' ', text: 'one', oldNo: 1, newNo: 1 },
      { kind: '-', text: 'two', oldNo: 2, newNo: null },
      { kind: '+', text: 'TWO', oldNo: null, newNo: 2 },
      { kind: ' ', text: 'three', oldNo: 3, newNo: 3 },
    ]);
    expect(h2.header).toBe('@@ -10,2 +10,3 @@ function x() {');
    expect(files[0].status).toBe('modified');
    expect(files[0].binary).toBe(false);
    expect(files[1].hunks[0].oldLines).toBe(1);
  });

  it('does not turn "\\ No newline at end of file" into a line', () => {
    const [, b] = parseUnifiedDiff(TWO_FILES);
    expect(b.hunks[0].lines.map((l) => l.kind + l.text)).toEqual(['-old', '+new']);
  });

  it('tells added, deleted and renamed apart', () => {
    const text = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..111
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+a
+b
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 111..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old.txt b/moved.txt
similarity index 90%
rename from old.txt
rename to moved.txt
index 111..222 100644
--- a/old.txt
+++ b/moved.txt
@@ -1 +1 @@
-x
+y
`;
    const [added, deleted, renamed] = parseUnifiedDiff(text);
    expect([added.path, added.status]).toEqual(['new.txt', 'added']);
    expect([deleted.path, deleted.status]).toEqual(['gone.txt', 'deleted']);
    expect([renamed.path, renamed.oldPath, renamed.status]).toEqual(['moved.txt', 'old.txt', 'renamed']);
    expect(added.hunks[0].lines.every((l) => l.kind === '+')).toBe(true);
  });

  it('marks binary files with no hunks', () => {
    const text = `diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`;
    const [file] = parseUnifiedDiff(text);
    expect(file).toMatchObject({ path: 'img.png', binary: true, hunks: [] });
  });

  it('keeps names with spaces and accents', () => {
    const text = `diff --git a/docs/coração e alma.md b/docs/coração e alma.md
index 111..222 100644
--- a/docs/coração e alma.md\t
+++ b/docs/coração e alma.md\t
@@ -1 +1 @@
-a
+b
`;
    expect(parseUnifiedDiff(text)[0].path).toBe('docs/coração e alma.md');
  });

  it('strips the trailing tab git adds to ---/+++ for names with spaces (added and deleted)', () => {
    const text = `diff --git a/my f.md b/my f.md
deleted file mode 100644
--- a/my f.md\t
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/n f.md b/n f.md
new file mode 100644
--- /dev/null
+++ b/n f.md\t
@@ -0,0 +1 @@
+x
`;
    expect(parseUnifiedDiff(text).map((f) => f.path)).toEqual(['my f.md', 'n f.md']);
  });

  it('keeps the name of a binary file with spaces', () => {
    const text = `diff --git a/my pic.png b/my pic.png
new file mode 100644
index 0000000..111
Binary files /dev/null and b/my pic.png differ
`;
    const [file] = parseUnifiedDiff(text);
    expect([file.path, file.status, file.binary]).toEqual(['my pic.png', 'added', true]);
  });

  it('returns an empty list for empty text', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('hunkId', () => {
  const lines = [
    { kind: ' ', text: 'a' },
    { kind: '+', text: 'b' },
  ];
  it('is 16 hex chars', () => {
    expect(hunkId('f.js', lines)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('ignores where the hunk sits', () => {
    const moved = parseUnifiedDiff(TWO_FILES.replace('@@ -1,3 +1,3 @@', '@@ -41,3 +41,3 @@'));
    const orig = parseUnifiedDiff(TWO_FILES);
    expect(moved[0].hunks[0].id).toBe(orig[0].hunks[0].id);
  });
  it('changes with one more letter', () => {
    const other = [lines[0], { kind: '+', text: 'bb' }];
    expect(hunkId('f.js', other)).not.toBe(hunkId('f.js', lines));
  });
  it('changes with the path', () => {
    expect(hunkId('g.js', lines)).not.toBe(hunkId('f.js', lines));
  });
});

describe('parseNumstatZ', () => {
  it('reads plain, rename and binary entries', () => {
    const text = '3\t1\tsrc/a.js\0' + '0\t0\t\0old.txt\0new.txt\0' + '-\t-\timg.png\0';
    expect(parseNumstatZ(text)).toEqual([
      { path: 'src/a.js', oldPath: null, added: 3, removed: 1, binary: false },
      { path: 'new.txt', oldPath: 'old.txt', added: 0, removed: 0, binary: false },
      { path: 'img.png', oldPath: null, added: null, removed: null, binary: true },
    ]);
  });
  it('returns an empty list for empty text', () => {
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('markCommitted', () => {
  it('flags hunks that are not in the HEAD to worktree diff', () => {
    const base = parseUnifiedDiff(TWO_FILES);
    const head = parseUnifiedDiff(TWO_FILES.split('diff --git a/src/b.js')[0]);
    const marked = markCommitted(base, head);
    expect(marked[0].hunks.map((h) => h.committed)).toEqual([false, false]);
    expect(marked[1].hunks.map((h) => h.committed)).toEqual([true]);
  });
});

describe('baseCandidates', () => {
  it('puts the configured base first, then upstream and the usual names', () => {
    expect(baseCandidates({ upstream: 'origin/feat', config: { base: 'dev' } })).toEqual([
      'dev', 'origin/feat', 'origin/main', 'main', 'origin/master', 'master',
    ]);
  });
  it('skips what is missing and does not repeat', () => {
    expect(baseCandidates({ upstream: 'origin/main' })).toEqual([
      'origin/main', 'main', 'origin/master', 'master',
    ]);
  });
});

describe('untrackedAsFiles', () => {
  it('builds added files with a hunk of plus lines', () => {
    const [file] = untrackedAsFiles(['n.txt'], () => 'a\nb\n');
    expect(file).toMatchObject({ path: 'n.txt', oldPath: null, status: 'added', binary: false });
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({ header: '@@ -0,0 +1,2 @@', newStart: 1, newLines: 2 });
    expect(file.hunks[0].lines[1]).toEqual({ kind: '+', text: 'b', oldNo: null, newNo: 2 });
    expect(file.hunks[0].id).toMatch(/^[0-9a-f]{16}$/);
  });
  it('treats a NUL in the first 8 KB as binary', () => {
    const [file] = untrackedAsFiles(['b.bin'], () => 'ab\0cd');
    expect(file).toMatchObject({ binary: true, hunks: [] });
  });
  it('gives an empty file no hunks', () => {
    expect(untrackedAsFiles(['e'], () => '')[0].hunks).toEqual([]);
  });
});

describe('no newline at end of file', () => {
  const text = 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n keep\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
  it('flags the preceding line without changing the hunk id', () => {
    const [f] = parseUnifiedDiff(text);
    const lines = f.hunks[0].lines;
    expect(lines.map((l) => !!l.noNewline)).toEqual([false, true, true]);
    expect(f.hunks[0].id).toBe(hunkId('a.txt', lines));
    expect(f.hunks[0].id).toBe(hunkId('a.txt', [{ kind: ' ', text: 'keep' }, { kind: '-', text: 'old' }, { kind: '+', text: 'new' }]));
  });
});
