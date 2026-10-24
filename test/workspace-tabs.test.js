import { describe, it, expect } from 'vitest';
import { linkTerminals, restorePlan, tabsToSave, terminalCommand } from '../src/main/workspace-tabs.js';

const ID = '4b706711-9840-4931-8b0f-d6d51518d6ba';

describe('terminalCommand', () => {
  it('starts nothing in a plain terminal, claude in a new chat, and resumes by id', () => {
    expect(terminalCommand({ kind: 'shell' })).toEqual({ command: null });
    expect(terminalCommand({ kind: 'claude' })).toEqual({ command: 'claude' });
    expect(terminalCommand({ kind: 'resume', sessionId: ID })).toEqual({ command: `claude --resume ${ID}` });
    expect(terminalCommand({ kind: 'picker' })).toEqual({ command: 'claude --resume' });
  });

  it('never types a session id that is not one (it goes straight into a shell)', () => {
    expect(terminalCommand({ kind: 'resume', sessionId: 'x; rm -rf ~' }).error).toBeTruthy();
    expect(terminalCommand({ kind: 'resume' }).error).toBeTruthy();
    expect(terminalCommand({ kind: 'sudo' }).error).toBeTruthy();
  });
});

describe('tabsToSave', () => {
  const terminals = [
    { id: 'p1', cwd: '/r', alive: true },
    { id: 'p2', cwd: '/r/wt', alive: true },
    { id: 'p3', cwd: '/r', alive: false },
  ];

  it('keeps the live tabs in order, each with the chat running in it', () => {
    const sessions = [{ id: ID, term: { VIZOR_PTY_ID: 'p2' } }];
    expect(tabsToSave({ terminals, sessions, liveIds: new Set([ID]), activeId: 'p2' })).toEqual({
      tabs: [
        { cwd: '/r', sessionId: null },
        { cwd: '/r/wt', sessionId: ID },
      ],
      active: 1,
    });
  });

  it('a chat that already ended in its tab is not resumed: the tab comes back as a shell', () => {
    const sessions = [{ id: ID, term: { VIZOR_PTY_ID: 'p2' } }];
    expect(tabsToSave({ terminals, sessions, liveIds: new Set(), activeId: null }).tabs[1]).toEqual({
      cwd: '/r/wt',
      sessionId: null,
    });
  });

  it('with no live registry to read (null), trusts the tab mapping', () => {
    const sessions = [{ id: ID, term: { VIZOR_PTY_ID: 'p1' } }];
    expect(tabsToSave({ terminals, sessions, liveIds: null, activeId: 'p9' })).toEqual({
      tabs: [
        { cwd: '/r', sessionId: ID },
        { cwd: '/r/wt', sessionId: null },
      ],
      active: null,
    });
  });

  it('a tab resumed at start keeps its chat before any hook event names it', () => {
    expect(
      tabsToSave({ terminals, sessions: [], liveIds: new Set([ID]), activeId: null, resumed: new Map([['p2', ID]]) })
        .tabs[1],
    ).toEqual({ cwd: '/r/wt', sessionId: ID });
  });

  it('the most recent chat of a tab wins (sessions come newest first)', () => {
    const sessions = [
      { id: ID, term: { VIZOR_PTY_ID: 'p1' } },
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', term: { VIZOR_PTY_ID: 'p1' } },
    ];
    expect(tabsToSave({ terminals, sessions, liveIds: null, activeId: null }).tabs[0].sessionId).toBe(ID);
  });
});

describe('restorePlan', () => {
  const exists = (dir) => dir !== '/gone';

  it('reopens each tab in its folder, resuming its chat', () => {
    const saved = { tabs: [{ cwd: '/r', sessionId: null }, { cwd: '/r/wt', sessionId: ID }], active: 1 };
    expect(restorePlan({ saved, liveIds: new Set(), dirExists: exists })).toEqual({
      open: [
        { cwd: '/r', sessionId: null, active: false },
        { cwd: '/r/wt', sessionId: ID, active: true },
      ],
      skipped: [],
    });
  });

  it('skips a folder that is gone and a chat already open somewhere else', () => {
    const saved = { tabs: [{ cwd: '/gone', sessionId: null }, { cwd: '/r', sessionId: ID }], active: 0 };
    expect(restorePlan({ saved, liveIds: new Set([ID]), dirExists: exists })).toEqual({
      open: [],
      skipped: [
        { cwd: '/gone', why: 'pasta não existe' },
        { cwd: '/r', why: 'conversa aberta em outro lugar' },
      ],
    });
  });

  it('survives a missing or broken saved state', () => {
    expect(restorePlan({ saved: undefined, liveIds: null, dirExists: exists })).toEqual({ open: [], skipped: [] });
    expect(restorePlan({ saved: { tabs: 'x' }, liveIds: null, dirExists: exists })).toEqual({ open: [], skipped: [] });
    expect(
      restorePlan({ saved: { tabs: [{ cwd: 3 }, { cwd: '/r', sessionId: 'bad id' }] }, liveIds: null, dirExists: exists }),
    ).toEqual({ open: [{ cwd: '/r', sessionId: null, active: false }], skipped: [] });
  });
});

describe('linkTerminals', () => {
  it('points a resumed chat at its new tab before its first hook event', () => {
    const sessions = [{ id: ID, cwd: '/r', term: { VIZOR_PTY_ID: 'old', KITTY_WINDOW_ID: '2' } }];
    expect(linkTerminals(sessions, ['new'], new Map([['new', ID]]))).toEqual([
      { id: ID, cwd: '/r', term: { VIZOR_PTY_ID: 'new', KITTY_WINDOW_ID: '2' } },
    ]);
  });

  it('a session whose tab no longer exists is no longer shown as in the Vizor', () => {
    const sessions = [
      { id: ID, term: { VIZOR_PTY_ID: 'gone' } },
      { id: 'b', term: { VIZOR_PTY_ID: 'p1' } },
      { id: 'c', term: null },
    ];
    expect(linkTerminals(sessions, ['p1'], new Map())).toEqual([
      { id: ID, term: null },
      { id: 'b', term: { VIZOR_PTY_ID: 'p1' } },
      { id: 'c', term: null },
    ]);
  });

  it('a hook event naming the tab beats the restore mapping, and nothing is mutated', () => {
    const session = { id: ID, term: { VIZOR_PTY_ID: 'p1' } };
    const out = linkTerminals([session], ['p1', 'p2'], new Map([['p2', ID]]));
    expect(out[0].term.VIZOR_PTY_ID).toBe('p1');
    expect(out[0]).toBe(session);
  });
});
