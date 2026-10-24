import { execFile } from 'node:child_process';
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
  const directory = path.dirname(filePath);
  const toplevel = await git(['rev-parse', '--show-toplevel'], directory);
  if (!toplevel) return null;
  const relative = path.relative(toplevel.trim(), filePath).split(path.sep).join('/');
  // --filters applies the checkout conversions (eol, smudge), so the baseline
  // has the same line endings as the file on disk it is diffed against.
  return git(['cat-file', '--filters', `:${relative}`], toplevel.trim());
}
