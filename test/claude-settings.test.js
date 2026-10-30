import { describe, it, expect } from 'vitest';
import {
  INBOUND_POLICIES,
  INBOUND_DEFAULT,
  readClaudeSettingsFile,
  readInboundPolicy,
  setInboundPolicy,
} from '../src/main/claude-settings.js';

describe('readClaudeSettingsFile (#165)', () => {
  const failing = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it('a missing file is an empty start', () => {
    expect(readClaudeSettingsFile(failing('ENOENT'))).toEqual({});
  });

  it('a file that does not parse, is not an object or cannot be read is unreadable (null): never rewritten', () => {
    expect(readClaudeSettingsFile(() => '{ "hooks": ')).toBeNull();
    expect(readClaudeSettingsFile(() => '[]')).toBeNull();
    expect(readClaudeSettingsFile(() => '"x"')).toBeNull();
    expect(readClaudeSettingsFile(() => 'null')).toBeNull();
    expect(readClaudeSettingsFile(failing('EACCES'))).toBeNull();
  });

  it('a good file comes back as is', () => {
    expect(readClaudeSettingsFile(() => '{"model":"opus"}')).toEqual({ model: 'opus' });
  });
});

describe('inbound policy', () => {
  it('offers exactly the values Claude Code accepts', () => {
    expect(INBOUND_POLICIES).toEqual(['accept', 'hold', 'refuse']);
  });

  it('reads an explicit value', () => {
    expect(readInboundPolicy({ crossSessionInbound: 'accept' })).toBe('accept');
    expect(readInboundPolicy({ crossSessionInbound: 'hold' })).toBe('hold');
    expect(readInboundPolicy({ crossSessionInbound: 'refuse' })).toBe('refuse');
  });

  // Unset is meaningful in Claude Code: it means "mode parity", not "accept".
  it('reports the default when unset, unknown or absent', () => {
    expect(readInboundPolicy({})).toBe(INBOUND_DEFAULT);
    expect(readInboundPolicy({ crossSessionInbound: 'sim' })).toBe(INBOUND_DEFAULT);
    expect(readInboundPolicy(null)).toBe(INBOUND_DEFAULT);
  });

  it('writes the value without disturbing anything else', () => {
    const settings = { hooks: { Stop: [{ hooks: [{ command: 'x' }] }] }, env: { A: '1' } };
    const next = setInboundPolicy(settings, 'accept');
    expect(next.crossSessionInbound).toBe('accept');
    expect(next.hooks).toEqual(settings.hooks);
    expect(next.env).toEqual(settings.env);
  });

  it('does not mutate the settings it was given', () => {
    const settings = { env: { A: '1' } };
    setInboundPolicy(settings, 'refuse');
    expect(settings.crossSessionInbound).toBeUndefined();
  });

  // Going back to the default has to REMOVE the key — leaving "hold" behind
  // would keep overriding mode parity, which is not the same thing.
  it('removes the key when going back to the default', () => {
    const next = setInboundPolicy({ crossSessionInbound: 'accept', env: { A: '1' } }, INBOUND_DEFAULT);
    expect('crossSessionInbound' in next).toBe(false);
    expect(next.env).toEqual({ A: '1' });
  });

  it('refuses an invalid value instead of writing it', () => {
    expect(setInboundPolicy({}, 'sim')).toBeNull();
    expect(setInboundPolicy({}, '')).toBeNull();
    expect(setInboundPolicy({}, undefined)).toBeNull();
  });

  it('works from missing settings', () => {
    expect(setInboundPolicy(null, 'hold')).toEqual({ crossSessionInbound: 'hold' });
  });
});
