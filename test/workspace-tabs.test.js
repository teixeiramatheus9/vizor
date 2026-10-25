import { describe, it, expect } from 'vitest';
import { createQuitFreeze, linkTerminals, restorePlan, tabsToSave, terminalCommand, trackChatEnds } from '../src/main/workspace-tabs.js';

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
  const none = new Set();

  it('keeps the live tabs in order, each with the chat running in it', () => {
    const sessions = [{ id: ID, term: { VIZOR_PTY_ID: 'p2' } }];
    expect(tabsToSave({ terminals, sessions, ended: none, activeId: 'p2' })).toEqual({
      tabs: [
        { cwd: '/r', sessionId: null },
        { cwd: '/r/wt', sessionId: ID },
      ],
      active: 1,
    });
  });

  it('a chat seen ending in its tab is not resumed: the tab comes back as a shell', () => {
    const sessions = [{ id: ID, term: { VIZOR_PTY_ID: 'p2' } }];
    expect(tabsToSave({ terminals, sessions, ended: new Set([ID]), activeId: null }).tabs[1]).toEqual({
      cwd: '/r/wt',
      sessionId: null,
    });
  });

  it('liveness at save time does not matter: a logout kills the chats before the save (review C-1)', () => {
    const sessions = [{ id: ID, term: { VIZOR_PTY_ID: 'p1' } }];
    expect(tabsToSave({ terminals, sessions, ended: none, activeId: null }).tabs[0].sessionId).toBe(ID);
  });

  it('a tab resumed at start keeps its chat before any hook event names it', () => {
    expect(
      tabsToSave({ terminals, sessions: [], ended: none, activeId: null, resumed: new Map([['p2', ID]]) }).tabs[1],
    ).toEqual({ cwd: '/r/wt', sessionId: ID });
  });

  it('a chat the hooks place in a tab beats an old resume mapping', () => {
    const other = 'aaaaaaaa-0000-4000-8000-000000000000';
    const sessions = [{ id: other, term: { VIZOR_PTY_ID: 'p2' } }];
    expect(
      tabsToSave({ terminals, sessions, ended: none, activeId: null, resumed: new Map([['p2', ID]]) }).tabs[1]
        .sessionId,
    ).toBe(other);
  });

  it('never saves one chat in two tabs (review I-2)', () => {
    const sessions = [{ id: ID, term: { VIZOR_PTY_ID: 'p2' } }];
    expect(
      tabsToSave({ terminals, sessions, ended: none, activeId: null, resumed: new Map([['p1', ID]]) }).tabs.map(
        (tab) => tab.sessionId,
      ),
    ).toEqual([null, ID]);
  });

  it('the most recent chat of a tab wins (sessions come newest first)', () => {
    const sessions = [
      { id: ID, term: { VIZOR_PTY_ID: 'p1' } },
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', term: { VIZOR_PTY_ID: 'p1' } },
    ];
    expect(tabsToSave({ terminals, sessions, ended: none, activeId: null }).tabs[0].sessionId).toBe(ID);
  });
});

describe('trackChatEnds', () => {
  it('a chat ends only after it was seen alive, and comes back when alive again', () => {
    const seen = new Set();
    const ended = new Set();
    trackChatEnds({ watched: [ID], liveIds: new Set(), seen, ended });
    expect(ended.has(ID)).toBe(false); // never seen: still starting
    trackChatEnds({ watched: [ID], liveIds: new Set([ID]), seen, ended });
    trackChatEnds({ watched: [ID], liveIds: new Set(), seen, ended });
    expect(ended.has(ID)).toBe(true);
    trackChatEnds({ watched: [ID], liveIds: new Set([ID]), seen, ended });
    expect(ended.has(ID)).toBe(false);
  });

  it('an unreadable registry (null) says nothing', () => {
    const seen = new Set([ID]);
    const ended = new Set();
    trackChatEnds({ watched: [ID], liveIds: null, seen, ended });
    expect(ended.size).toBe(0);
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

  it('never resumes one chat twice (review I-2)', () => {
    const saved = { tabs: [{ cwd: '/r', sessionId: ID }, { cwd: '/r', sessionId: ID }], active: 1 };
    expect(restorePlan({ saved, liveIds: new Set(), dirExists: exists }).open).toEqual([
      { cwd: '/r', sessionId: ID, active: false },
      { cwd: '/r', sessionId: null, active: true },
    ]);
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

describe('createQuitFreeze (#157)', () => {
  const setup = () => {
    const log = [];
    const timers = new Map();
    let next = 1;
    const freeze = createQuitFreeze({
      freeze: () => log.push('freeze'),
      thaw: () => log.push('thaw'),
      setTimer: (fn, ms) => {
        const id = next++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
      graceMs: 10000,
    });
    const fire = () => {
      for (const [id, { fn }] of [...timers]) {
        timers.delete(id);
        fn();
      }
    };
    return { freeze, log, timers, fire };
  };

  it('freezes the tabs when the quit starts and keeps them frozen once it goes through', () => {
    const { freeze, log, timers, fire } = setup();
    freeze.beforeQuit();
    expect(log).toEqual(['freeze']);
    freeze.willQuit();
    expect(timers.size).toBe(0);
    fire();
    expect(log).toEqual(['freeze']);
  });

  it('thaws the tabs when the quit never reaches will-quit (it was cancelled)', () => {
    const { freeze, log, timers, fire } = setup();
    freeze.beforeQuit();
    expect([...timers.values()][0].ms).toBe(10000);
    fire();
    expect(log).toEqual(['freeze', 'thaw']);
  });

  it('a second quit attempt restarts the grace period', () => {
    const { freeze, log, timers, fire } = setup();
    freeze.beforeQuit();
    freeze.beforeQuit();
    expect(timers.size).toBe(1);
    fire();
    expect(log).toEqual(['freeze', 'freeze', 'thaw']);
  });
});
