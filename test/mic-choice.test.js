import { describe, expect, it } from 'vitest';
import { listMics, pickMic } from '../src/renderer/mic-choice.js';

const devices = [
  { kind: 'audioinput', deviceId: 'default', label: 'Padrão - Microfone digital' },
  { kind: 'audioinput', deviceId: 'communications', label: 'Comunicações' },
  { kind: 'audioinput', deviceId: 'a1', label: 'Microfone digital' },
  { kind: 'audioinput', deviceId: 'h510', label: 'H510-PRO Wireless headset' },
  { kind: 'audiooutput', deviceId: 'spk', label: 'Alto-falantes' },
];

describe('the mic picker (#161: the default input became a silent headset)', () => {
  it('lists the real inputs only, never the default/communications aliases or outputs', () => {
    expect(listMics(devices)).toEqual([
      { id: 'a1', label: 'Microfone digital' },
      { id: 'h510', label: 'H510-PRO Wireless headset' },
    ]);
  });

  it('the chosen mic by id; by name when the id changed; the system default when it is gone or none was chosen', () => {
    expect(pickMic(devices, { id: 'h510', label: 'H510-PRO Wireless headset' })).toBe('h510');
    expect(pickMic(devices, { id: 'old-id', label: 'Microfone digital' })).toBe('a1');
    expect(pickMic(devices, { id: 'usb', label: 'Blue Yeti' })).toBeNull();
    expect(pickMic(devices, null)).toBeNull();
  });
});

describe('normalizeMic: what main accepts from the settings and the mic window', async () => {
  const { normalizeMic, normalizeMicList } = await import('../src/renderer/mic-choice.js');
  it('a pinned mic is an id and a label, short strings; anything else is the system default', () => {
    expect(normalizeMic({ id: 'a1', label: 'Microfone digital', extra: 1 })).toEqual({ id: 'a1', label: 'Microfone digital' });
    expect(normalizeMic(null)).toBeNull();
    expect(normalizeMic({ id: 3 })).toBeNull();
    expect(normalizeMic({ id: '', label: 'x' })).toBeNull();
    expect(normalizeMic({ id: 'x'.repeat(600), label: 'y' })).toBeNull();
  });

  it('the device list from the mic window keeps only valid entries, at most 32', () => {
    expect(normalizeMicList([{ id: 'a', label: 'A' }, { id: 5 }, 'x'])).toEqual([{ id: 'a', label: 'A' }]);
    expect(normalizeMicList('nope')).toEqual([]);
    expect(normalizeMicList(Array.from({ length: 50 }, (_, index) => ({ id: `m${index}`, label: 'M' })))).toHaveLength(32);
  });
});
