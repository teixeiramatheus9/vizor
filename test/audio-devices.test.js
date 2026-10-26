import { describe, expect, it } from 'vitest';
import { listSinks, normalizeOutput } from '../src/main/audio-devices.js';

const dump = [
  { type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'alsa_output.pci.analog', 'node.description': 'Alto-falantes' } } },
  { type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'alsa_output.usb.h510', 'node.description': 'H510-PRO Wireless headset' } } },
  { type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Source', 'node.name': 'alsa_input.pci', 'node.description': 'Microfone' } } },
  { type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Stream/Output/Audio', 'node.name': 'Firefox' } } },
  { type: 'PipeWire:Interface:Port', info: { props: {} } },
];

describe('audio outputs (the tray menu picks where the Vizor speaks)', () => {
  it('lists the sinks from pw-dump, by name and description, sorted by description', () => {
    expect(listSinks(dump)).toEqual([
      { name: 'alsa_output.pci.analog', label: 'Alto-falantes' },
      { name: 'alsa_output.usb.h510', label: 'H510-PRO Wireless headset' },
    ]);
    expect(listSinks(null)).toEqual([]);
  });

  it('normalizeOutput: a pinned output is a name and a label; anything else is the system default', () => {
    expect(normalizeOutput({ name: 'alsa_output.usb.h510', label: 'H510', x: 1 })).toEqual({ name: 'alsa_output.usb.h510', label: 'H510' });
    expect(normalizeOutput({ name: '' })).toBeNull();
    expect(normalizeOutput(null)).toBeNull();
  });
});

describe('chromiumSinkId: the bubble chimes follow the pinned output', async () => {
  const { chromiumSinkId } = await import('../src/main/audio-devices.js');
  it('matched by name; the system default or an unknown output is ""', () => {
    const outputs = [{ id: 'c1', label: 'Alto-falantes' }, { id: 'c2', label: 'H510-PRO Wireless headset' }];
    expect(chromiumSinkId(outputs, { name: 'alsa_output.usb.h510', label: 'H510-PRO Wireless headset' })).toBe('c2');
    expect(chromiumSinkId(outputs, null)).toBe('');
    expect(chromiumSinkId(outputs, { name: 'x', label: 'Sumiu' })).toBe('');
  });
});
