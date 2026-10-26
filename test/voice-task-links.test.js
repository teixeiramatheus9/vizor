import { describe, it, expect } from 'vitest';
import { createTaskLinks, resolveTask } from '../src/main/voice/task-links.js';

const conv = (sessionId, title, cwd = '/r', updatedAt = 1) => ({ sessionId, title, cwd, updatedAt });

describe('resolveTask', () => {
  const worktrees = [
    { path: '/r', branch: 'main' },
    { path: '/r-wt/login', branch: 'feat/22-login' },
    { path: '/r-wt/other', branch: 'feat/122-x' },
  ];

  it('a stored link wins while its conversation still exists', () => {
    const conversations = [conv('s-linked', 'qualquer'), conv('s-title', 'task 22: login')];
    expect(resolveTask({ number: 22, links: ['s-linked'], conversations, worktrees })).toEqual({ sessionId: 's-linked', cwd: '/r' });
    expect(resolveTask({ number: 22, links: ['s-gone'], conversations, worktrees: [] })).toEqual({ sessionId: 's-title', cwd: '/r' });
  });

  it('a worktree whose branch names the task, with its newest conversation', () => {
    const conversations = [conv('old', 'a', '/r-wt/login', 1), conv('new', 'b', '/r-wt/login', 5), conv('x', 'c', '/r-wt/other', 9)];
    expect(resolveTask({ number: 22, links: [], conversations, worktrees })).toEqual({ sessionId: 'new', cwd: '/r-wt/login' });
  });

  it('122 is not 22', () => {
    const conversations = [conv('x', 'c', '/r-wt/other', 9)];
    expect(resolveTask({ number: 22, links: [], conversations, worktrees: worktrees.slice(2) })).toEqual({ none: true });
  });

  it('a task worktree without a chat yet: none, but where to open one', () => {
    expect(resolveTask({ number: 22, links: [], conversations: [], worktrees })).toEqual({ none: true, cwd: '/r-wt/login' });
  });

  it('two conversations citing the task are offered, not guessed', () => {
    const conversations = [conv('a', 'Issue #22 — login', '/r', 2), conv('b', 'continuar a tarefa 22', '/r', 3), conv('c', 'outra coisa #221')];
    expect(resolveTask({ number: 22, links: [], conversations, worktrees: [] })).toEqual({
      candidates: [
        { sessionId: 'b', title: 'continuar a tarefa 22', cwd: '/r' },
        { sessionId: 'a', title: 'Issue #22 — login', cwd: '/r' },
      ],
    });
  });
});

describe('task links store', () => {
  it('links, finds and forgets, persisted atomically', () => {
    const files = {};
    const io = {
      file: '/v/tasks.json',
      readFile: (file) => {
        if (!(file in files)) throw new Error('ENOENT');
        return files[file];
      },
      writeFile: (file, content) => (files[file] = content),
      rename: (from, to) => {
        files[to] = files[from];
        delete files[from];
      },
    };
    const links = createTaskLinks(io);
    links.link('/r', 22, 's1');
    links.link('/r', 22, 's2');
    links.link('/r', 5, 's1');
    expect(links.linksFor('/r', 22)).toEqual(['s2', 's1']);
    links.forgetSession('s1');
    expect(createTaskLinks(io).linksFor('/r', 22)).toEqual(['s2']);
    expect(createTaskLinks(io).linksFor('/r', 5)).toEqual([]);
    expect(Object.keys(files)).toEqual(['/v/tasks.json']);
  });
});

describe('resolveTask — final review fixes', () => {
  it('I8: a dotted version is not a task number', () => {
    expect(resolveTask({ number: 22, links: [], conversations: [], worktrees: [{ path: '/r-wt/int', branch: 'feat/0.22.0' }] })).toEqual({ none: true });
    expect(resolveTask({ number: 22, links: [], conversations: [], worktrees: [{ path: '/r-wt/x', branch: 'fix/22_login' }] })).toEqual({ none: true, cwd: '/r-wt/x' });
  });
});
