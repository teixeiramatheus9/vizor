import { describe, expect, it } from 'vitest';
import { shouldAnnounce, shouldAutoApply, updateAnnouncement } from '../src/main/update-notice.js';

describe('shouldAnnounce', () => {
  it('announces when the app came back on the version that was installed', () => {
    expect(shouldAnnounce({ version: '0.6.0' }, '0.6.0')).toBe(true);
  });

  it('stays quiet when the install did not land', () => {
    expect(shouldAnnounce({ version: '0.6.0' }, '0.5.0')).toBe(false);
  });

  it('stays quiet without a note', () => {
    expect(shouldAnnounce(null, '0.6.0')).toBe(false);
    expect(shouldAnnounce({}, '0.6.0')).toBe(false);
  });
});

describe('shouldAutoApply', () => {
  const base = { autoUpdate: true, mode: 'notify', available: '0.14.0', ready: null, installing: false, failed: false, attemptedVersion: null };

  it('waits while workspace terminals are alive: the restart would kill them', () => {
    expect(shouldAutoApply({ ...base, liveTerminals: 1 })).toBe(false);
    expect(shouldAutoApply({ ...base, liveTerminals: 0 })).toBe(true);
  });

  it('applies a notify-mode update as soon as one is available', () => {
    expect(shouldAutoApply(base)).toBe(true);
  });

  it('applies an auto-mode update only once it finished downloading', () => {
    expect(shouldAutoApply({ ...base, mode: 'auto', ready: null })).toBe(false);
    expect(shouldAutoApply({ ...base, mode: 'auto', ready: '0.14.0' })).toBe(true);
  });

  it('respects the setting being off', () => {
    expect(shouldAutoApply({ ...base, autoUpdate: false })).toBe(false);
  });

  it('never retries a version it already tried — a cancelled password prompt must not loop', () => {
    expect(shouldAutoApply({ ...base, attemptedVersion: '0.14.0' })).toBe(false);
    expect(shouldAutoApply({ ...base, attemptedVersion: '0.13.9' })).toBe(true);
  });

  it('stays put mid-install and after a failure', () => {
    expect(shouldAutoApply({ ...base, installing: true })).toBe(false);
    expect(shouldAutoApply({ ...base, failed: true })).toBe(false);
  });
});

describe('updateAnnouncement', () => {
  const quiet = { mode: 'auto', available: null, ready: null, installing: false, failed: false };

  it('announces the download starting in auto mode', () => {
    const text = updateAnnouncement(quiet, { ...quiet, available: '0.14.0' }, true);
    expect(text).toContain('0.14.0');
    expect(text).toMatch(/baixa/i);
  });

  it('announces the restart when a downloaded update will self-apply', () => {
    const text = updateAnnouncement({ ...quiet, available: '0.14.0' }, { ...quiet, available: '0.14.0', ready: '0.14.0' }, true);
    expect(text).toContain('0.14.0');
    expect(text).toMatch(/atualizar/i);
  });

  it('points at the banner instead when self-apply is off', () => {
    const text = updateAnnouncement({ ...quiet, available: '0.14.0' }, { ...quiet, available: '0.14.0', ready: '0.14.0' }, false);
    expect(text).toMatch(/banner/i);
  });

  it('warns about the password prompt when a notify-mode install starts', () => {
    const notify = { ...quiet, mode: 'notify', available: '0.14.0' };
    const text = updateAnnouncement(notify, { ...notify, installing: true }, true);
    expect(text).toMatch(/senha/i);
  });

  it('owns up to a failure once', () => {
    const notify = { ...quiet, mode: 'notify', available: '0.14.0' };
    expect(updateAnnouncement(notify, { ...notify, failed: true }, true)).toMatch(/release/i);
    expect(updateAnnouncement({ ...notify, failed: true }, { ...notify, failed: true }, true)).toBeNull();
  });

  it('says nothing when nothing changed', () => {
    expect(updateAnnouncement(quiet, { ...quiet }, true)).toBeNull();
  });
});

describe('update lines in English, for an English voice', () => {
  it('every transition and the after-restart line', async () => {
    const { updateDonePhrase } = await import('../src/main/update-notice.js');
    expect(updateAnnouncement({}, { failed: true }, true, 'en')).toBe('I tried to update and it went wrong, I left the release page open for you.');
    expect(updateAnnouncement({}, { installing: true, available: '1.2.0' }, true, 'en')).toBe('Downloading version 1.2.0 to update myself. If a password prompt shows up, just confirm it.');
    expect(updateAnnouncement({}, { ready: '1.2.0' }, true, 'en')).toBe("I downloaded version 1.2.0. I'll restart real quick to update!");
    expect(updateAnnouncement({}, { ready: '1.2.0' }, false, 'en')).toBe('Update 1.2.0 is ready. Click the banner in the panel to restart.');
    expect(updateAnnouncement({}, { available: '1.2.0', mode: 'auto' }, true, 'en')).toBe("Version 1.2.0 is out! I've started downloading it.");
    expect(updateDonePhrase('en')).toBe("Done, I'm updated! Running the new version now.");
    expect(updateDonePhrase()).toBe('Pronto, terminei de atualizar! Já tô na versão nova.');
  });
});
