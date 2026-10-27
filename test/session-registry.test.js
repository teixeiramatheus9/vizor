import { describe, it, expect, vi } from 'vitest';
import { SessionRegistry, STATUS, displayName, haloState } from '../src/main/session-registry.js';

const promptEvent = (overrides = {}) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 's1',
  cwd: '/home/user/projects/projeto-alpha',
  transcript_path: '/tmp/t.jsonl',
  ...overrides,
});

describe('SessionRegistry', () => {
  it('creates a working session on UserPromptSubmit', () => {
    const registry = new SessionRegistry();
    const session = registry.applyEvent(promptEvent());
    expect(session.status).toBe(STATUS.WORKING);
    expect(session.projectName).toBe('projeto-alpha');
    expect(session.unread).toBe(false);
  });

  it('keeps the chat subject when the manager has no title to offer', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent());
    registry.setManagerMessage('s1', { title: 'Corrigir update do rpm', message: 'pronto' });
    // the fallback voice (economy mode, or a failed claude -p) carries no title
    registry.setManagerMessage('s1', { message: 'Opa, terminou!' });
    expect(registry.list()[0].title).toBe('Corrigir update do rpm');
  });

  it('shows the last assistant message and drops it when the chat works again', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent());
    registry.setLastMessage('s1', 'Rodei a suíte: 192 testes passando.');
    expect(registry.list()[0].lastMessage).toBe('Rodei a suíte: 192 testes passando.');
    registry.applyEvent(promptEvent());
    expect(registry.list()[0].lastMessage).toBe(null);
  });

  it('keeps the terminal identity across events and ignores an empty capture', () => {
    const registry = new SessionRegistry();
    const term = { KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/tmp/kitty-sock' };
    registry.applyEvent(promptEvent({ term }));
    // a later event without the capture (older hook, sub-shell) must not erase it
    const session = registry.applyEvent(promptEvent({ hook_event_name: 'Stop' }));
    expect(session.term).toEqual(term);
    registry.applyEvent(promptEvent({ term: {} }));
    expect(registry.list()[0].term).toEqual(term);
  });

  it('marks session done and unread on Stop', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent());
    const session = registry.applyEvent(promptEvent({ hook_event_name: 'Stop' }));
    expect(session.status).toBe(STATUS.DONE);
    expect(session.unread).toBe(true);
    expect(registry.unreadCount()).toBe(1);
  });

  it('marks session waiting with the event message on Notification', () => {
    const registry = new SessionRegistry();
    const session = registry.applyEvent(
      promptEvent({ hook_event_name: 'Notification', message: 'precisa de permissão' }),
    );
    expect(session.status).toBe(STATUS.WAITING);
    expect(session.managerMessage).toBe('precisa de permissão');
    expect(session.unread).toBe(true);
  });

  it('ignores unknown events and events without session_id', () => {
    const registry = new SessionRegistry();
    expect(registry.applyEvent({ hook_event_name: 'PreToolUse', session_id: 'x' })).toBeNull();
    expect(registry.applyEvent(promptEvent({ session_id: undefined }))).toBeNull();
    expect(registry.list()).toHaveLength(0);
  });

  it('a new prompt resets unread and clears the manager message', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent({ hook_event_name: 'Stop' }));
    registry.setManagerMessage('s1', { title: 'fix bug', message: 'terminou!' });
    const session = registry.applyEvent(promptEvent());
    expect(session.unread).toBe(false);
    expect(session.managerMessage).toBeNull();
  });

  it('setManagerMessage stores title and message and emits change', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent({ hook_event_name: 'Stop' }));
    const listener = vi.fn();
    registry.on('change', listener);
    registry.setManagerMessage('s1', { title: 'fix bug', message: 'terminou po' });
    const [session] = registry.list();
    expect(session.title).toBe('fix bug');
    expect(session.managerMessage).toBe('terminou po');
    expect(listener).toHaveBeenCalled();
  });

  it('markAllRead clears unread flags', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent({ hook_event_name: 'Stop' }));
    registry.markAllRead();
    expect(registry.unreadCount()).toBe(0);
  });

  it('prune removes sessions older than maxAgeMs', () => {
    let currentTime = 1000;
    const registry = new SessionRegistry({ maxAgeMs: 500, now: () => currentTime });
    registry.applyEvent(promptEvent());
    currentTime = 2000;
    registry.applyEvent(promptEvent({ session_id: 's2', cwd: '/tmp/other' }));
    registry.prune();
    expect(registry.list().map((session) => session.id)).toEqual(['s2']);
  });

  it('keeps the FIRST prompt as the topic preview and truncates it', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent({ prompt: 'arruma o bug do login que tá quebrando tudo no ambiente de produção urgente' }));
    const session = registry.applyEvent(promptEvent({ prompt: 'segundo prompt' }));
    expect(session.promptPreview.startsWith('arruma o bug do login')).toBe(true);
    expect(session.promptPreview.length).toBeLessThanOrEqual(61);
  });

  it('setQuestion stores the pending question and a new prompt clears it', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent({ hook_event_name: 'Notification', message: 'esperando' }));
    const question = { questions: [{ question: 'Qual?', options: ['a', 'b'] }] };
    registry.setQuestion('s1', question);
    expect(registry.list()[0].question).toEqual(question);
    registry.applyEvent(promptEvent());
    expect(registry.list()[0].question).toBeNull();
  });

  it('markAnswered clears the question and puts the session back to work', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent({ hook_event_name: 'Notification', message: 'esperando' }));
    registry.setQuestion('s1', { questions: [{ question: 'Qual?', options: ['a', 'b'] }] });
    registry.markAnswered('s1');
    const [session] = registry.list();
    expect(session.question).toBeNull();
    expect(session.status).toBe(STATUS.WORKING);
    expect(session.unread).toBe(false);
  });

  it('serialize/hydrate round-trips sessions without emitting change', () => {
    const source = new SessionRegistry();
    source.applyEvent(promptEvent({ hook_event_name: 'Stop' }));
    const restored = new SessionRegistry();
    const listener = vi.fn();
    restored.on('change', listener);
    restored.hydrate(source.serialize());
    expect(listener).not.toHaveBeenCalled();
    expect(restored.list()).toEqual(source.list());
    restored.hydrate([{ notAnId: true }]);
    expect(restored.list()).toHaveLength(1);
  });

  it('list sorts by updatedAt descending', () => {
    let currentTime = 1;
    const registry = new SessionRegistry({ now: () => currentTime });
    registry.applyEvent(promptEvent());
    currentTime = 2;
    registry.applyEvent(promptEvent({ session_id: 's2', cwd: '/tmp/other' }));
    expect(registry.list()[0].id).toBe('s2');
  });
});

describe('reconciling against the live Claude Code sessions', () => {
  const S1 = '4b706711-9840-4931-8b0f-d6d51518d6ba';
  const S2 = '7d6b682c-5c11-4e0a-b3d2-9f0e1a7c4d55';
  const withSessions = (...ids) => {
    const registry = new SessionRegistry();
    // finished chats: one that dies mid-turn leaves a tombstone instead
    for (const id of ids) {
      registry.applyEvent(promptEvent({ session_id: id, hook_event_name: 'Stop' }));
    }
    return registry;
  };

  it('drops a session whose terminal was closed', () => {
    const registry = withSessions(S1, S2);
    registry.reconcileLiveSessions(new Set([S1, S2]));

    registry.reconcileLiveSessions(new Set([S1]));

    expect([...registry.sessions.keys()]).toEqual([S1]);
  });

  // A session the manager never saw in the registry may be running on a build
  // without it, so its absence proves nothing and it must survive.
  it('keeps a session it never saw alive in the registry', () => {
    const registry = withSessions(S1);

    registry.reconcileLiveSessions(new Set());

    expect([...registry.sessions.keys()]).toEqual([S1]);
  });

  it('ignores a null reading, which means the registry is unreadable', () => {
    const registry = withSessions(S1);
    registry.reconcileLiveSessions(new Set([S1]));

    registry.reconcileLiveSessions(null);

    expect([...registry.sessions.keys()]).toEqual([S1]);
  });

  it('announces the change only when a session actually went away', () => {
    const registry = withSessions(S1);
    registry.reconcileLiveSessions(new Set([S1]));
    const onChange = vi.fn();
    registry.on('change', onChange);

    registry.reconcileLiveSessions(new Set([S1]));
    expect(onChange).not.toHaveBeenCalled();

    registry.reconcileLiveSessions(new Set());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // Sessions persisted before this app knew about liveness carry no flag, so
  // they would otherwise sit there until the 12h prune. A registry listing a
  // live session proves it works on this machine, which makes absence mean
  // something on its own.
  it('reaps an unflagged session once the registry proves it is working', () => {
    const registry = new SessionRegistry();
    registry.hydrate([{ id: '6b2aa174-1f3e-4a5c-9d80-2b1c4e7f9a03', updatedAt: 1 }]);

    registry.reconcileLiveSessions(new Set(['4b706711-9840-4931-8b0f-d6d51518d6ba']));

    expect([...registry.sessions.keys()]).toEqual([]);
  });

  // simulate-event.sh fabricates sessions with no process behind them; the
  // registry can never list one, so its absence proves nothing.
  it('keeps a simulated session the registry could never list', () => {
    const registry = withSessions('sim-projeto-teste');

    registry.reconcileLiveSessions(new Set(['4b706711-9840-4931-8b0f-d6d51518d6ba']));

    expect([...registry.sessions.keys()]).toEqual(['sim-projeto-teste']);
  });

  // Liveness survives a restart through sessions.json, so a session closed
  // while the app was down is reaped on the first reading after it comes back.
  it('reaps a hydrated session that was seen alive before the restart', () => {
    const registry = new SessionRegistry();
    registry.hydrate([{ id: S1, seenAlive: true, updatedAt: 1 }]);

    registry.reconcileLiveSessions(new Set());

    expect([...registry.sessions.keys()]).toEqual([]);
  });
});

describe('remove', () => {
  it('drops the session and reports the change', () => {
    const registry = new SessionRegistry();
    registry.applyEvent({ hook_event_name: 'Stop', session_id: 's1', cwd: '/tmp/a' });
    registry.applyEvent({ hook_event_name: 'Stop', session_id: 's2', cwd: '/tmp/b' });
    let changes = 0;
    registry.on('change', () => (changes += 1));

    registry.remove('s1');
    expect(registry.list().map((session) => session.id)).toEqual(['s2']);
    expect(changes).toBe(1);
  });

  it('stays quiet for an id that is not there', () => {
    const registry = new SessionRegistry();
    let changes = 0;
    registry.on('change', () => (changes += 1));
    registry.remove('nope');
    expect(changes).toBe(0);
  });

  it('lets a new event bring the chat back', () => {
    const registry = new SessionRegistry();
    registry.applyEvent({ hook_event_name: 'Stop', session_id: 's1', cwd: '/tmp/a' });
    registry.remove('s1');
    registry.applyEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp/a' });
    expect(registry.list()).toHaveLength(1);
    expect(registry.sessions.get('s1').status).toBe('working');
  });
});

describe('adopting sessions found in the live registry', () => {
  const S1 = '4b706711-9840-4931-8b0f-d6d51518d6ba';
  const S2 = '7d6b682c-5c11-4e0a-b3d2-9f0e1a7c4d55';
  const found = (overrides = {}) => ({
    sessionId: S1,
    cwd: '/home/user/projects/projeto-alpha',
    name: 'claude-manager-28',
    status: 'busy',
    transcriptPath: '/tmp/t.jsonl',
    ...overrides,
  });

  it('adopts an unknown busy session as a working chat', () => {
    const registry = new SessionRegistry();
    expect(registry.adopt([found()])).toBe(1);
    const session = registry.sessions.get(S1);
    expect(session.status).toBe(STATUS.WORKING);
    expect(session.projectName).toBe('projeto-alpha');
    expect(session.transcriptPath).toBe('/tmp/t.jsonl');
    expect(session.unread).toBe(false);
  });

  // An idle chat finished whatever it was doing long before the adoption; done
  // without unread describes it without ringing any bell.
  it('adopts an idle session as done and quiet', () => {
    const registry = new SessionRegistry();
    registry.adopt([found({ status: 'idle' })]);
    const session = registry.sessions.get(S1);
    expect(session.status).toBe(STATUS.DONE);
    expect(session.unread).toBe(false);
  });

  // Adoption proves the registry lists this session, so a later reconcile is
  // allowed to reap it when it disappears.
  it('marks an adopted session as seen alive', () => {
    const registry = new SessionRegistry();
    registry.adopt([found({ status: 'idle' })]);
    registry.reconcileLiveSessions(new Set([S2]));
    expect(registry.sessions.has(S1)).toBe(false);
  });

  it('never clobbers a chat the hooks already reported', () => {
    const registry = new SessionRegistry();
    registry.applyEvent({
      hook_event_name: 'Stop',
      session_id: S1,
      cwd: '/home/user/projects/projeto-alpha',
    });
    expect(registry.adopt([found()])).toBe(0);
    expect(registry.sessions.get(S1).status).toBe(STATUS.DONE);
    expect(registry.sessions.get(S1).unread).toBe(true);
  });

  it('announces one change for the whole batch and none when empty-handed', () => {
    const registry = new SessionRegistry();
    const onChange = vi.fn();
    registry.on('change', onChange);
    expect(registry.adopt([found(), found({ sessionId: S2 })])).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(registry.adopt([found()])).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('refuses ids Claude Code could never have issued', () => {
    const registry = new SessionRegistry();
    expect(registry.adopt([found({ sessionId: 'sim-projeto-teste' })])).toBe(0);
  });
});


// Issue #63: aliases live in their own field — projectName is recomputed from
// cwd on EVERY event, so writing the alias there would last one hook.
describe('aliases', () => {
  const stopEvent = { hook_event_name: 'Stop', session_id: 's1', cwd: '/home/x/vizor' };

  it('setAlias names a session and survives the next hook event', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(stopEvent);
    registry.setAlias('s1', 'bolha nova');
    registry.applyEvent({ ...stopEvent, hook_event_name: 'UserPromptSubmit' });
    const session = registry.sessions.get('s1');
    expect(session.alias).toBe('bolha nova');
    expect(session.projectName).toBe('vizor');
  });

  it('an empty alias clears the nickname', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(stopEvent);
    registry.setAlias('s1', 'x');
    registry.setAlias('s1', '   ');
    expect(registry.sessions.get('s1').alias).toBeNull();
  });

  it('setAlias emits change so persistence and the panel follow', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(stopEvent);
    const onChange = vi.fn();
    registry.on('change', onChange);
    registry.setAlias('s1', 'apelido');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('displayName', () => {
  it('is the session own alias, else the basename — never a folder-wide name', () => {
    expect(displayName({ alias: null, projectName: 'web' })).toBe('web');
    expect(displayName({ alias: 'front novo', projectName: 'web' })).toBe('front novo');
  });
});

// Renaming chat A must NEVER rename its sibling B in the same folder — that
// was the whole point of issue #63. The folder default only names NEWBORN
// sessions (materialized as their own alias at creation, renameable after).
describe('folder default aliases', () => {
  const stop = (id) => ({ hook_event_name: 'Stop', session_id: id, cwd: '/h/vizor' });

  it('a newborn session is baptized with the folder default as its own alias', () => {
    const registry = new SessionRegistry({ folderAliasFor: () => 'Vizor terminal' });
    registry.applyEvent(stop('novo'));
    expect(registry.sessions.get('novo').alias).toBe('Vizor terminal');
  });

  it('renaming one chat never touches its sibling in the same folder', () => {
    const aliases = {};
    const registry = new SessionRegistry({ folderAliasFor: (cwd) => aliases[cwd] });
    registry.applyEvent(stop('a'));
    registry.applyEvent(stop('b'));
    registry.setAlias('a', 'Vizor terminal');
    aliases['/h/vizor'] = 'Vizor terminal'; // what the rename IPC persists
    registry.applyEvent(stop('b')); // more events on the sibling
    expect(displayName(registry.sessions.get('a'))).toBe('Vizor terminal');
    expect(displayName(registry.sessions.get('b'))).toBe('vizor');
  });

  it('a session already known never gets re-baptized by the folder default', () => {
    const aliases = {};
    const registry = new SessionRegistry({ folderAliasFor: (cwd) => aliases[cwd] });
    registry.applyEvent(stop('velho'));
    aliases['/h/vizor'] = 'nome novo';
    registry.applyEvent(stop('velho'));
    expect(registry.sessions.get('velho').alias).toBeNull();
  });
});


// Notification waves on the bubble: colored halo until the user opens the
// panel — red beats yellow beats green when several chats compete.
describe('permission asks', () => {
  const notification = (extra = {}) => ({
    hook_event_name: 'Notification',
    session_id: 's1',
    cwd: '/h/vizor',
    message: 'quer permissão',
    ...extra,
  });

  it('a permission Notification marks the session as needing permission', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(notification({ permissionAsk: true }));
    expect(registry.sessions.get('s1').needsPermission).toBe(true);
  });

  it('a plain idle Notification does not', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(notification());
    expect(registry.sessions.get('s1').needsPermission).toBe(false);
  });

  it('answering (UserPromptSubmit) and finishing (Stop) clear the flag', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(notification({ permissionAsk: true }));
    registry.applyEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/h/vizor' });
    expect(registry.sessions.get('s1').needsPermission).toBe(false);
    registry.applyEvent(notification({ permissionAsk: true }));
    registry.applyEvent({ hook_event_name: 'Stop', session_id: 's1', cwd: '/h/vizor' });
    expect(registry.sessions.get('s1').needsPermission).toBe(false);
  });
});

describe('haloState', () => {
  const base = { unread: true, needsPermission: false, question: null };

  it('is null when nothing is unread', () => {
    expect(haloState([{ ...base, unread: false, status: STATUS.DONE }])).toBeNull();
  });

  it('green for an unread finished task', () => {
    expect(haloState([{ ...base, status: STATUS.DONE }])).toBe('done');
  });

  it('yellow for a pending question or a waiting chat', () => {
    expect(haloState([{ ...base, status: STATUS.WAITING }])).toBe('question');
    expect(haloState([{ ...base, status: STATUS.DONE, question: { questions: [] } }])).toBe('question');
  });

  it('red for a permission ask', () => {
    expect(haloState([{ ...base, status: STATUS.WAITING, needsPermission: true }])).toBe('permission');
  });

  it('the most urgent chat wins the bubble', () => {
    const sessions = [
      { ...base, status: STATUS.DONE },
      { ...base, status: STATUS.WAITING },
      { ...base, status: STATUS.WAITING, needsPermission: true },
    ];
    expect(haloState(sessions)).toBe('permission');
    expect(haloState(sessions.slice(0, 2))).toBe('question');
  });

  it('a read permission ask no longer glows', () => {
    expect(
      haloState([{ ...base, unread: false, status: STATUS.WAITING, needsPermission: true }]),
    ).toBeNull();
  });

  it('drops only a VIZOR_PTY_ID main found not to hold (#140)', () => {
    const registry = new SessionRegistry();
    registry.applyEvent({ hook_event_name: 'UserPromptSubmit', session_id: 'x1', cwd: '/r', term: { VIZOR_PTY_ID: 'p1', TMUX: 't' } });
    registry.applyEvent({ hook_event_name: 'Stop', session_id: 'x1', cwd: '/r', dropPtyId: true });
    expect(registry.sessions.get('x1').term).toEqual({ TMUX: 't' });
  });
});

describe('tombstones and seen marks', () => {
  const S1 = '4b706711-9840-4931-8b0f-d6d51518d6ba';
  const DAY = 24 * 60 * 60 * 1000;
  const live = (now) => {
    const registry = new SessionRegistry({ now, maxAgeMs: 7 * DAY });
    registry.applyEvent(promptEvent({ session_id: S1 }));
    registry.reconcileLiveSessions(new Set([S1]));
    return registry;
  };

  it('keeps a tombstone for a chat that died mid-turn', () => {
    let t = 1000;
    const registry = live(() => t);
    t = 5000;

    registry.reconcileLiveSessions(new Set());

    const [tomb] = registry.list();
    expect(tomb).toMatchObject({
      id: S1,
      status: STATUS.FAILED,
      failedAt: 5000,
      failReason: 'a sessão fechou no meio do turno',
    });
    expect(registry.unreadCount()).toBe(0);
  });

  it('keeps the tombstone through later reconciles', () => {
    let t = 1000;
    const registry = live(() => t);
    registry.reconcileLiveSessions(new Set());
    t = 9000;
    registry.reconcileLiveSessions(new Set());
    expect(registry.list()[0].failedAt).toBe(1000);
  });

  it('drops a chat that died after its Stop', () => {
    const registry = live(() => 1000);
    registry.applyEvent(promptEvent({ session_id: S1, hook_event_name: 'Stop' }));
    registry.reconcileLiveSessions(new Set());
    expect(registry.list()).toEqual([]);
  });

  it('still never reaps a session it cannot judge', () => {
    const registry = new SessionRegistry();
    registry.applyEvent(promptEvent({ session_id: S1 }));
    registry.reconcileLiveSessions(new Set());
    expect(registry.list()[0].status).toBe(STATUS.WORKING);
  });

  it('a tombstoned chat that comes back is a live session again', () => {
    const registry = live(() => 1000);
    registry.reconcileLiveSessions(new Set());
    registry.applyEvent(promptEvent({ session_id: S1 }));
    const session = registry.list()[0];
    expect(session.status).toBe(STATUS.WORKING);
    expect(session.failedAt).toBeUndefined();
    expect(session.failReason).toBeUndefined();
  });

  it('prune drops a tombstone only after 24 h', () => {
    let t = 1000;
    const registry = live(() => t);
    registry.reconcileLiveSessions(new Set());
    t = 1000 + DAY;
    registry.prune();
    expect(registry.list()).toHaveLength(1);
    t = 1000 + DAY + 1;
    registry.prune();
    expect(registry.list()).toEqual([]);
  });

  it('dismiss removes the tombstone', () => {
    const registry = live(() => 1000);
    registry.reconcileLiveSessions(new Set());
    const onChange = vi.fn();
    registry.on('change', onChange);
    registry.dismiss(S1);
    expect(registry.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('dismiss leaves a live session alone', () => {
    const registry = live(() => 1000);
    registry.dismiss(S1);
    expect(registry.list()).toHaveLength(1);
  });

  it('markSeen stamps the time', () => {
    let t = 1000;
    const registry = live(() => t);
    t = 4000;
    registry.markSeen(S1);
    expect(registry.list()[0].seenAt).toBe(4000);
  });

  it('markSeen on an unknown id is a no-op', () => {
    const registry = new SessionRegistry();
    const onChange = vi.fn();
    registry.on('change', onChange);
    registry.markSeen('nope');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('serialize/hydrate carries seenAt, failedAt and failReason', () => {
    const registry = live(() => 1000);
    registry.markSeen(S1);
    registry.reconcileLiveSessions(new Set());
    const restored = new SessionRegistry();
    restored.hydrate(registry.serialize());
    expect(restored.list()[0]).toMatchObject({
      seenAt: 1000,
      failedAt: 1000,
      failReason: 'a sessão fechou no meio do turno',
    });
  });
});
