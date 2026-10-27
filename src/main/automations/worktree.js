// Level-2 (worktree) preparation: a sibling checkout of the repo on a fresh
// branch, so an automação edits there and never in the user's tree. IO injected.
import { basename, dirname, join, resolve } from 'node:path';
import { baseCandidates } from '../review/git-diff.js';

const pad = (n) => String(n).padStart(2, '0');
const branchStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const failed = (reason) => ({ status: 'failed', reason });

// git(args, { cwd }) → { code, stdout }; exists(path) → boolean.
export async function prepareWorktree(a, { git, exists, repoRoot, base, home, now = () => new Date() }) {
  const root = resolve(repoRoot);
  const path = join(dirname(root), `${basename(root)}-auto-${a.slug}`);
  // The guard refuses edits under .claude/, at / and in the home itself.
  if (path === '/' || (home && path === resolve(home)) || path.split('/').includes('.claude')) {
    return failed('A pasta da worktree cairia num lugar proibido. Escolha outro projeto.');
  }
  const refExists = async (ref) => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root })).code === 0;
  let baseRef = null;
  for (const candidate of baseCandidates({ config: base ? { base } : undefined })) {
    if (await refExists(candidate)) { baseRef = candidate; break; }
  }
  if (!baseRef) return failed('Não achei a branch base (origin/main ou main) neste projeto.');

  const branch = `auto/${a.slug}/${branchStamp(now())}`;
  if (await exists(path)) {
    const status = await git(['status', '--porcelain'], { cwd: path });
    if (status.code !== 0) return failed('Não consegui ler o estado da worktree da automação.');
    if (status.stdout.trim()) {
      return failed('A worktree da automação tem mudanças não commitadas de uma execução anterior. Revise ou descarte antes de rodar de novo.');
    }
    const co = await git(['checkout', '-b', branch, baseRef], { cwd: path });
    if (co.code !== 0) return failed('Não consegui criar a branch da automação na worktree.');
  } else {
    const add = await git(['worktree', 'add', '-b', branch, path, baseRef], { cwd: root });
    if (add.code !== 0) return failed('Não consegui criar a worktree da automação.');
  }
  return { ok: true, path, branch, base: baseRef };
}
