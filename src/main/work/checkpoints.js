// Checkpoints of a worktree per step, kept as refs/vizor/tarefa/<issue>/<n>.
// The tree is built through a temporary index, so the dev's index and worktree
// are never touched. Git and the temp dir are injected.
import { execFile } from 'node:child_process';
import { mkdtemp, rm as fsRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const REF = /^refs\/vizor\/tarefa\/\d+\/\d+$/;
const bad = (what) => new Error(`${what} inválido`);
const positive = (n) => Number.isInteger(n) && n > 0;
const lines = (text) => String(text).split('\n').filter(Boolean);
const checkWorktree = (dir) => {
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0') || dir.split(/[\\/]/).includes('..')) throw bad('Caminho do worktree');
};

// A commit needs an identity even where the dev has none configured.
const IDENTITY = { GIT_AUTHOR_NAME: 'vizor', GIT_AUTHOR_EMAIL: 'vizor@localhost', GIT_COMMITTER_NAME: 'vizor', GIT_COMMITTER_EMAIL: 'vizor@localhost' };

export const execGit = (args, { cwd, env } = {}) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim()));
    else resolve(stdout);
  });
});

export function createCheckpoints({
  git,
  mkTemp = () => mkdtemp(join(tmpdir(), 'vizor-cp-')),
  rm = (dir) => fsRm(dir, { recursive: true, force: true }),
}) {
  async function take(worktree, issue, n) {
    checkWorktree(worktree);
    if (!positive(issue) || !positive(n)) throw bad('Número da tarefa ou do passo');
    // No HEAD means no parent to build on: refuse instead of crashing half-way.
    try { await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: worktree }); } catch {
      throw new Error('O repositório ainda não tem commits: não dá pra guardar o passo.');
    }
    const ref = `refs/vizor/tarefa/${issue}/${n}`;
    const dir = await mkTemp();
    try {
      const opts = { cwd: worktree, env: { GIT_INDEX_FILE: join(dir, 'index'), ...IDENTITY } };
      await git(['read-tree', 'HEAD'], opts);
      await git(['add', '-A'], opts);
      const tree = String(await git(['write-tree'], opts)).trim();
      const sha = String(await git(['commit-tree', tree, '-p', 'HEAD', '-m', `vizor checkpoint ${issue}/${n}`], opts)).trim();
      await git(['update-ref', ref, sha], { cwd: worktree });
      return { ref, sha };
    } finally {
      await rm(dir);
    }
  }

  async function diff(worktree, fromRef, toRef) {
    checkWorktree(worktree);
    for (const r of [fromRef, toRef]) if (r != null && !REF.test(r) && r !== 'HEAD') throw bad('Ref');
    if (toRef == null) throw bad('Ref');
    return String(await git(['diff', '--no-color', '-U3', fromRef ?? 'HEAD', toRef], { cwd: worktree }));
  }

  // Puts the checkpoint's files back; whatever the checkpoint never had stays and is reported.
  async function restore(worktree, ref) {
    checkWorktree(worktree);
    if (!REF.test(String(ref))) throw bad('Ref');
    const cwd = worktree;
    const changed = lines(await git(['diff', '--name-status', '--no-renames', ref], { cwd }));
    const known = new Set(lines(await git(['ls-tree', '-r', '--name-only', ref], { cwd })));
    const untracked = lines(await git(['ls-files', '-o', '--exclude-standard'], { cwd }));
    const restored = changed.filter((l) => !l.startsWith('A')).map((l) => l.split('\t')[1]);
    const added = changed.filter((l) => l.startsWith('A')).map((l) => l.split('\t')[1]);
    const left = [...new Set([...added, ...untracked])].filter((f) => !known.has(f));
    await git(['restore', `--source=${ref}`, '--worktree', '--', '.'], { cwd });
    return { restored, left };
  }

  async function drop(worktree, issue) {
    checkWorktree(worktree);
    if (!positive(issue)) throw bad('Número da tarefa');
    const refs = lines(await git(['for-each-ref', '--format=%(refname)', `refs/vizor/tarefa/${issue}/`], { cwd: worktree }));
    for (const ref of refs) await git(['update-ref', '-d', ref], { cwd: worktree });
  }

  return { take, diff, restore, drop };
}
