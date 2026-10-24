import { describe, it, expect } from 'vitest';
import {
  answerKeys,
  answerRoute,
  bubbleClickTarget,
  pickWorkspaceSession,
  replyRoute,
  workspaceFocusOverride,
} from '../src/main/bubble-routing.js';

const inside = (extra = {}) => ({ id: 's1', status: 'done', term: { VIZOR_PTY_ID: 'p1' }, ...extra });
const question = (extra = {}) => ({ questions: [{ question: 'Qual?', multiSelect: false, options: ['a', 'b', 'c'], ...extra }] });

describe('bubbleClickTarget', () => {
  it('opens the workspace only where it exists (Linux)', () => {
    expect(bubbleClickTarget({ workspaceAvailable: true })).toBe('workspace');
    expect(bubbleClickTarget({ workspaceAvailable: false })).toBe('panel');
  });
});

describe('pickWorkspaceSession', () => {
  const sessions = [
    { id: 'a', updatedAt: 10 },
    { id: 'b', updatedAt: 30 },
    { id: 'c', updatedAt: 20 },
  ];
  it('prefers the session of the last notice', () => {
    expect(pickWorkspaceSession({ lastNoticeSessionId: 'c', sessions })).toBe('c');
  });
  it('falls back to the most recently active one', () => {
    expect(pickWorkspaceSession({ lastNoticeSessionId: 'gone', sessions })).toBe('b');
    expect(pickWorkspaceSession({ lastNoticeSessionId: null, sessions })).toBe('b');
  });
  it('is null with no session', () => {
    expect(pickWorkspaceSession({ lastNoticeSessionId: null, sessions: [] })).toBeNull();
  });
});

describe('replyRoute', () => {
  it('uses the terminal only for an idle Vizor session with claude in front', () => {
    expect(replyRoute({ session: inside(), claudeInFront: true })).toBe('pty');
    expect(replyRoute({ session: inside({ status: 'waiting' }), claudeInFront: true })).toBe('pty');
  });
  it('keeps the old path otherwise', () => {
    expect(replyRoute({ session: inside({ needsPermission: true, status: 'waiting' }), claudeInFront: true })).toBe('default');
    expect(replyRoute({ session: inside({ status: 'waiting', question: question() }), claudeInFront: true })).toBe('default');
    expect(replyRoute({ session: inside({ status: 'working' }), claudeInFront: true })).toBe('default');
    expect(replyRoute({ session: inside(), claudeInFront: false })).toBe('default');
    expect(replyRoute({ session: { id: 's1', status: 'done', term: null }, claudeInFront: true })).toBe('default');
  });
});

describe('answerRoute', () => {
  it('answers a single-select question by arrows in the terminal', () => {
    expect(answerRoute({ session: inside({ status: 'waiting', question: question() }), claudeInFront: true })).toBe('pty');
  });
  it('keeps the text answer for anything less certain', () => {
    expect(answerRoute({ session: inside({ status: 'waiting', question: question({ multiSelect: true }) }), claudeInFront: true })).toBe('default');
    const two = { questions: [question().questions[0], question().questions[0]] };
    expect(answerRoute({ session: inside({ status: 'waiting', question: two }), claudeInFront: true })).toBe('default');
    expect(answerRoute({ session: inside({ status: 'working', question: question() }), claudeInFront: true })).toBe('default');
    expect(answerRoute({ session: inside({ status: 'waiting', question: question() }), claudeInFront: false })).toBe('default');
  });
});

describe('answerKeys', () => {
  it('moves down to the option', () => {
    expect(answerKeys(2)).toBe('\x1b[B\x1b[B');
    expect(answerKeys(0)).toBe('');
  });
});

describe('workspaceFocusOverride', () => {
  it('is only sure about the session the focused workspace shows', () => {
    expect(workspaceFocusOverride({ windowFocused: true, selectedSessionId: 'b', sessionId: 'b' })).toBe(true);
    expect(workspaceFocusOverride({ windowFocused: true, selectedSessionId: 'b', sessionId: 'a' })).toBeNull();
    expect(workspaceFocusOverride({ windowFocused: false, selectedSessionId: 'b', sessionId: 'b' })).toBeNull();
  });
});
