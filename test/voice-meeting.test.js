import { describe, it, expect } from 'vitest';
import { otherRecorders } from '../src/main/voice/meeting.js';

const node = (props) => ({ type: 'PipeWire:Interface:Node', info: { props } });

describe('otherRecorders', () => {
  it('lists the other apps recording the mic, not us, not monitors, not outputs', () => {
    const dump = [
      node({ 'media.class': 'Stream/Input/Audio', 'application.name': 'Google Chrome', 'application.process.id': '4100' }),
      node({ 'media.class': 'Stream/Input/Audio', 'application.name': 'Chromium', 'application.process.id': '900' }),
      node({ 'media.class': 'Stream/Input/Audio', 'application.name': 'OBS', 'application.process.id': '5000', 'stream.capture.sink': 'true' }),
      node({ 'media.class': 'Stream/Output/Audio', 'application.name': 'Spotify', 'application.process.id': '6000' }),
      node({ 'media.class': 'Audio/Source', 'node.name': 'alsa_input.dmic' }),
      { type: 'PipeWire:Interface:Link', info: {} },
    ];
    expect(otherRecorders(dump, new Set([900]))).toEqual(['Google Chrome']);
  });

  it('a bad dump is no meeting', () => {
    expect(otherRecorders(null, new Set())).toEqual([]);
    expect(otherRecorders('x', new Set())).toEqual([]);
  });
});

describe('parsePwDump', () => {
  it('reads the first JSON array even when more output follows (live bug: "non-whitespace after JSON")', async () => {
    const { parsePwDump } = await import('../src/main/voice/meeting.js');
    const first = JSON.stringify([node({ 'media.class': 'Stream/Input/Audio', 'application.name': 'Meet', 'application.process.id': '7' })]);
    expect(otherRecorders(parsePwDump(`${first}\n[\n  {"id": 3, "info": {}}\n]\n`), new Set())).toEqual(['Meet']);
    expect(parsePwDump('not json')).toBeNull();
    expect(parsePwDump('[{"a": "]"}] trailing')).toEqual([{ a: ']' }]);
  });
});
