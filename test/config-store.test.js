import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/main/config-store.js';

describe('config store', () => {
  it('returns defaults when the file does not exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-config-'));
    expect(loadConfig(path.join(dir, 'config.json'))).toEqual(DEFAULT_CONFIG);
  });

  it('leaves the crt overlay off until it is asked for', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-config-'));
    expect(loadConfig(path.join(dir, 'config.json')).crt).toBe(false);
  });

  it('migrates a pre-skin colour theme into theme + palette', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-config-'));
    const file = path.join(dir, 'config.json');
    saveConfig(file, { theme: 'magenta' });
    const config = loadConfig(file);
    expect(config.theme).toBe('classico');
    expect(config.palette).toBe('magenta');
  });

  it('round-trips and merges defaults for missing keys', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-config-'));
    const file = path.join(dir, 'config.json');
    saveConfig(file, { terminal: 'kitty' });
    const config = loadConfig(file);
    expect(config.terminal).toBe('kitty');
    expect(config.tokenBudgetDaily).toBe(DEFAULT_CONFIG.tokenBudgetDaily);
  });

  it('normalizes workspace lists to arrays of strings (#105)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cfg-ws-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ workspaceProjects: 'oops', workspaceDismissed: ['/a', 3, null] }));
    const config = loadConfig(file);
    expect(config.workspaceProjects).toEqual([]);
    expect(config.workspaceDismissed).toEqual(['/a']);
  });
});
