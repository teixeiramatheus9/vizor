import { describe, it, expect, vi } from 'vitest';
import { renderSkill, skillPath, writeSkill, removeSkill } from '../src/main/automations/skill.js';

const auto = { id: 'a1', name: 'Resumo do dia', slug: 'resumo-do-dia', prompt: 'Resuma os commits de ontem.\nSeja breve.', projectRoot: '/work/app', skillScope: 'personal' };

describe('renderSkill', () => {
  it('writes exact frontmatter and the prompt as the body', () => {
    expect(renderSkill(auto)).toBe(
      '---\nname: vizor-resumo-do-dia\ndescription: "Automação do Vizor: Resumo do dia"\n---\n\nResuma os commits de ontem.\nSeja breve.\n',
    );
  });
  it('keeps the description a single valid YAML line even with quotes or newlines in the name', () => {
    const out = renderSkill({ ...auto, name: 'Diz "oi"\nlinha' });
    const line = out.split('\n')[2];
    expect(line.startsWith('description: "Automação do Vizor: ')).toBe(true);
    expect(JSON.parse(line.slice('description: '.length))).toBe('Automação do Vizor: Diz "oi" linha');
  });
});

describe('skillPath', () => {
  it('personal lives under the home, project under the project root', () => {
    expect(skillPath(auto, { home: '/home/u' })).toBe('/home/u/.claude/skills/vizor-resumo-do-dia/SKILL.md');
    expect(skillPath({ ...auto, skillScope: 'project' }, { home: '/home/u' })).toBe('/work/app/.claude/skills/vizor-resumo-do-dia/SKILL.md');
  });
});

describe('writeSkill', () => {
  it('creates the folder and writes atomically', async () => {
    const calls = [];
    const io = {
      home: '/home/u',
      mkdir: async (p, o) => calls.push(['mkdir', p, o]),
      writeFile: async (p, t) => calls.push(['write', p, t]),
      rename: async (a, b) => calls.push(['rename', a, b]),
    };
    const p = await writeSkill(auto, io);
    expect(p).toBe('/home/u/.claude/skills/vizor-resumo-do-dia/SKILL.md');
    expect(calls.map((c) => c[0])).toEqual(['mkdir', 'write', 'rename']);
    expect(calls[0][1]).toBe('/home/u/.claude/skills/vizor-resumo-do-dia');
    expect(calls[1][1]).toBe(`${p}.tmp`);
    expect(calls[1][2]).toBe(renderSkill(auto));
    expect(calls[2].slice(1)).toEqual([`${p}.tmp`, p]);
  });
});

describe('removeSkill', () => {
  it('refuses an unsafe slug before touching the disk', async () => {
    const rm = vi.fn();
    await expect(removeSkill({ ...auto, slug: '../..' }, { home: '/h', rm })).rejects.toThrow(/slug/);
    await expect(removeSkill({ ...auto, slug: '' }, { home: '/h', rm })).rejects.toThrow(/slug/);
    expect(rm).not.toHaveBeenCalled();
  });
  it('removes the skill folder; personal skills are never checked against git', async () => {
    const rm = vi.fn(async () => {});
    const gitLsFiles = vi.fn(async () => 'x');
    const r = await removeSkill(auto, { home: '/home/u', rm, gitLsFiles });
    expect(rm).toHaveBeenCalledWith('/home/u/.claude/skills/vizor-resumo-do-dia', { recursive: true, force: true });
    expect(gitLsFiles).not.toHaveBeenCalled();
    expect(r.needsCommit).toBe(false);
  });
  it('warns that removing a tracked project skill needs a commit', async () => {
    const rm = vi.fn(async () => {});
    const p = { ...auto, skillScope: 'project' };
    const gitLsFiles = vi.fn(async () => '.claude/skills/vizor-resumo-do-dia/SKILL.md\n');
    const r = await removeSkill(p, { home: '/home/u', rm, gitLsFiles });
    expect(gitLsFiles).toHaveBeenCalledWith('/work/app/.claude/skills/vizor-resumo-do-dia/SKILL.md', '/work/app');
    expect(rm).toHaveBeenCalled();
    expect(r.needsCommit).toBe(true);
    expect(r.warning).toMatch(/commit/i);
  });
  it('an untracked project skill, or a failing git, needs no commit', async () => {
    const p = { ...auto, skillScope: 'project' };
    const rm = async () => {};
    expect((await removeSkill(p, { home: '/h', rm, gitLsFiles: async () => '' })).needsCommit).toBe(false);
    expect((await removeSkill(p, { home: '/h', rm, gitLsFiles: async () => { throw new Error('not a repo'); } })).needsCommit).toBe(false);
  });
});
