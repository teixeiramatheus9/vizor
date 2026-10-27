// The SKILL.md that backs each automação: personal by default
// (~/.claude/skills/vizor-<slug>/), or inside the project when asked.
import { join, dirname } from 'node:path';

export function renderSkill(a) {
  // JSON.stringify gives a one-line, valid YAML double-quoted scalar, so a
  // name with quotes or colons cannot break the frontmatter.
  const oneLine = String(a.name).replace(/\s+/g, ' ').trim();
  const description = JSON.stringify(`Automação do Vizor: ${oneLine}`);
  return `---\nname: vizor-${a.slug}\ndescription: ${description}\n---\n\n${a.prompt.replace(/\n+$/, '')}\n`;
}

const skillDir = (a, home) => join(a.skillScope === 'project' ? a.projectRoot : home, '.claude', 'skills', `vizor-${a.slug}`);

export const skillPath = (a, { home }) => join(skillDir(a, home), 'SKILL.md');

export async function writeSkill(a, { home, mkdir, writeFile, rename }) {
  const path = skillPath(a, { home });
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, renderSkill(a));
  await rename(tmp, path);
  return path;
}

// gitLsFiles(path, cwd) resolves to `git ls-files <path>` output. A tracked
// project skill is deleted from disk all the same, but the caller is told the
// deletion still has to be committed.
export async function removeSkill(a, { home, rm, gitLsFiles }) {
  const path = skillPath(a, { home });
  let tracked = false;
  if (a.skillScope === 'project') {
    try { tracked = Boolean((await gitLsFiles(path, a.projectRoot))?.trim()); } catch { /* not a repo: nothing to commit */ }
  }
  await rm(skillDir(a, home), { recursive: true, force: true });
  return tracked
    ? { path, needsCommit: true, warning: 'A skill está versionada no git do projeto: faça commit da remoção.' }
    : { path, needsCommit: false };
}
