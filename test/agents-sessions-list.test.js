import { describe, it, expect } from 'vitest';
import { buildAgentSessions, questionText } from '../src/main/agents/sessions-list.js';

const tree = {
  projects: [{ root: '/p/a', worktrees: [{ path: '/p/a', branch: 'feat/x', sessions: [{ id: 's1' }] }] }],
};
const base = { id: 's1', status: 'working', updatedAt: 10, projectName: 'a', cwd: '/p/a', term: { VIZOR_PTY_ID: 'pty-1' } };

describe('buildAgentSessions', () => {
  it('flattens a placed session with its project, branch and pty', () => {
    const [entry] = buildAgentSessions({ sessions: [{ ...base, title: 'Tarefa' }], tree });
    expect(entry).toMatchObject({ id: 's1', ptyId: 'pty-1', project: { root: '/p/a', branch: 'feat/x' }, title: 'Tarefa', seenAt: 0 });
    expect(entry.term).toEqual({ VIZOR_PTY_ID: 'pty-1' });
  });
  it('leaves outside sessions without a project or a pty', () => {
    const [entry] = buildAgentSessions({ sessions: [{ ...base, id: 's9', term: null }], tree });
    expect(entry.project).toBeNull();
    expect(entry.term).toBeNull();
    expect(entry.ptyId).toBeNull();
  });
  it('prefixes the issue number', () => {
    const [entry] = buildAgentSessions({ sessions: [{ ...base, title: 'Ajustar' }], tree, issueOf: () => 169 });
    expect(entry.title).toBe('#169 Ajustar');
  });
  it('carries the tombstone and adoption flags', () => {
    const [entry] = buildAgentSessions({ sessions: [{ ...base, status: 'failed', failedAt: 5, adopted: true }], tree });
    expect(entry).toMatchObject({ status: 'failed', failedAt: 5, adopted: true });
  });
  it('turns the pending question into text', () => {
    expect(questionText({ questions: [{ question: 'Qual?' }] })).toBe('Qual?');
    expect(questionText(null)).toBeNull();
    expect(questionText({})).toBe('Esperando sua resposta.');
  });
});
