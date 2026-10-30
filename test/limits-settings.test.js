import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectStatusLineOverrides, tapStatusText } from '../src/main/limits/limits-settings.js';

describe('projectStatusLineOverrides', () => {
  it('finds projects with their own statusLine in either settings file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-lim-'));
    const mk = (name, file, body) => {
      const root = path.join(dir, name);
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      if (file) fs.writeFileSync(path.join(root, '.claude', file), body);
      return root;
    };
    const a = mk('a', 'settings.json', '{"statusLine":{"type":"command","command":"x"}}');
    const b = mk('b', 'settings.local.json', '{"statusLine":{"command":"y"}}');
    const c = mk('c', 'settings.json', '{"permissions":{}}');
    const d = mk('d', 'settings.json', '{broken');
    expect(projectStatusLineOverrides([a, b, c, d, path.join(dir, 'missing')]).map((p) => p.name)).toEqual(['a', 'b']);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('tapStatusText', () => {
  it('maps the tap state', () => {
    expect(tapStatusText({ tap: { installed: true }, seenAt: 5 }).text).toBe('conectada');
    expect(tapStatusText({ tap: { installed: true }, seenAt: null }).text).toBe('sem chats ainda');
    expect(tapStatusText({ tap: { replaced: true } }).kind).toBe('replaced');
    expect(tapStatusText({ tap: { installed: false } }).kind).toBe('off');
  });
});
