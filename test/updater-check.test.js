import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.21.0', relaunch: () => {}, exit: () => {} },
  shell: { openExternal: () => {} },
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: { on: () => {}, checkForUpdates: async () => {} } } }));

const { setupUpdater } = await import('../src/main/updater.js');

describe('update check reports failures (#55)', () => {
  afterEach(() => vi.useRealTimers());

  it('a failed check says it failed instead of "already on the latest"', async () => {
    vi.useFakeTimers();
    const updater = setupUpdater({
      onStatus: () => {},
      log: () => {},
      fetchFn: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    const status = await updater.check();
    expect(status.checkFailed).toBe(true);
  });

  it('a successful check clears the failure', async () => {
    vi.useFakeTimers();
    let fail = true;
    const updater = setupUpdater({
      onStatus: () => {},
      log: () => {},
      fetchFn: async () => (fail ? { ok: false, status: 500 } : { ok: true, json: async () => ({ tag_name: 'v0.21.0' }) }),
    });
    await updater.check();
    fail = false;
    const status = await updater.check();
    expect(status.checkFailed).toBe(false);
    expect(status.available).toBeNull();
  });
});
