import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

// The staged version of a file, as it would be checked out — the last baseline the user vouched for, and
// the one fallback when an edit cannot be reversed. Null when the file is not
// in a repo, not in the index, or git fails in any way.
export async function readIndexVersion(filePath) {
  // git reports the toplevel as a real path: a file reached through a symlink
  // would otherwise sit at '../…' from it and never resolve (#101).
  const real = await realpath(filePath).catch(() => null);
  if (!real) return null;
  filePath = real;
  const directory = path.dirname(filePath);
  const toplevel = await git(['rev-parse', '--show-toplevel'], directory);
  if (!toplevel) return null;
  const relative = path.relative(toplevel.trim(), filePath).split(path.sep).join('/');
  // --filters applies the checkout conversions (eol, smudge), so the baseline
  // has the same line endings as the file on disk it is diffed against.
  return git(['cat-file', '--filters', `:${relative}`], toplevel.trim());
}
