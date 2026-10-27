// Checkpoints of a worktree per step, kept as refs/vizor/tarefa/<issue>/<n>.
// The tree is built through a temporary index, so the dev's index and worktree
// are never touched. Git and the temp dir are injected.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath as fsRealpath, rm as fsRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const bad = (what) => new Error(`${what} inválido`);
const positive = (n) => Number.isInteger(n) && n > 0;
// Step 0 is the baseline: the files before step 1.
const stepNumber = (n) => Number.isInteger(n) && n >= 0;
const lines = (text) => String(text).split('\n').filter(Boolean);
// -z output: names come raw (no C-quoting of non-ASCII), split on NUL.
const nuls = (text) => String(text).split('\0').filter(Boolean);
const GIT_TIMEOUT_MS = 60_000;
const checkWorktree = (dir) => {
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0') || dir.split(/[\\/]/).includes('..')) throw bad('Caminho do worktree');
};

// A commit needs an identity even where the dev has none configured.
const IDENTITY = { GIT_AUTHOR_NAME: 'vizor', GIT_AUTHOR_EMAIL: 'vizor@localhost', GIT_COMMITTER_NAME: 'vizor', GIT_COMMITTER_EMAIL: 'vizor@localhost' };

export const execGit = (args, { cwd, env } = {}) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
    if (err?.killed) reject(new Error('O git demorou demais e foi interrompido.'));
    else if (err) reject(new Error(String(stderr || err.message).trim()));
    else resolve(stdout);
  });
});

export function createCheckpoints({
  git,
  mkTemp = () => mkdtemp(join(tmpdir(), 'vizor-cp-')),
  rm = (dir) => fsRm(dir, { recursive: true, force: true }),
  realpath = fsRealpath,
}) {
  // Refs are shared by every linked worktree of a repo: the worktree id keeps tasks apart.
  // The worktree must be the repo root, or '.' and the listed paths would mean different things.
  async function prepare(worktree) {
    checkWorktree(worktree);
    const real = await realpath(worktree);
    let top;
    try { top = await realpath(String(await git(['rev-parse', '--show-toplevel'], { cwd: worktree })).trim()); } catch {
      throw new Error('Essa pasta não é um repositório git.');
    }
    if (top !== real) throw new Error('A pasta precisa ser a raiz do repositório (worktree), não uma subpasta.');
    const prefix = `refs/vizor/tarefa/${createHash('sha1').update(real).digest('hex').slice(0, 12)}/`;
    return { prefix, own: (ref) => typeof ref === 'string' && ref.startsWith(prefix) && /^\d+\/\d+$/.test(ref.slice(prefix.length)) };
  }

  async function take(worktree, issue, n) {
    if (!positive(issue) || !stepNumber(n)) throw bad('Número da tarefa ou do passo');
    const { prefix } = await prepare(worktree);
    // No HEAD means no parent to build on: refuse instead of crashing half-way.
    try { await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: worktree }); } catch {
      throw new Error('O repositório ainda não tem commits: não dá pra guardar o passo.');
    }
    const ref = `${prefix}${issue}/${n}`;
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
    if (toRef == null) throw bad('Ref');
    const { own } = await prepare(worktree);
    for (const r of [fromRef, toRef]) if (r != null && !own(r)) throw bad('Ref');
    return String(await git(['diff', '--no-color', '-U3', fromRef ?? 'HEAD', toRef], { cwd: worktree }));
  }

  // Puts the checkpoint's files back; whatever the checkpoint never had stays and is reported.
  async function restore(worktree, ref) {
    const { own } = await prepare(worktree);
    if (!own(ref)) throw bad('Ref');
    const cwd = worktree;
    const tokens = nuls(await git(['diff', '--name-status', '-z', '--no-renames', ref], { cwd }));
    const changed = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) changed.push({ status: tokens[i], file: tokens[i + 1] });
    const known = new Set(nuls(await git(['ls-tree', '-r', '-z', '--name-only', ref], { cwd })));
    const untracked = nuls(await git(['ls-files', '-o', '-z', '--exclude-standard'], { cwd }));
    const restored = changed.filter((c) => c.status !== 'A').map((c) => c.file);
    const added = changed.filter((c) => c.status === 'A').map((c) => c.file);
    const left = [...new Set([...added, ...untracked])].filter((f) => !known.has(f));
    await git(['restore', `--source=${ref}`, '--worktree', '--', '.'], { cwd });
    return { restored, left };
  }

  async function drop(worktree, issue) {
    if (!positive(issue)) throw bad('Número da tarefa');
    const { prefix } = await prepare(worktree);
    const refs = lines(await git(['for-each-ref', '--format=%(refname)', `${prefix}${issue}/`], { cwd: worktree }));
    for (const ref of refs) await git(['update-ref', '-d', ref], { cwd: worktree });
  }

  return { take, diff, restore, drop };
}
