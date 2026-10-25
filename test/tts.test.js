import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { playerCommand,
  predownloadVoice,
  speak,
  speakNeural,
  stopSpeaking,
  systemVoiceCommand, speakableText } from '../src/main/tts.js';
import {
  DEFAULT_VOICE,
  VOICES,
  isVoiceInstalled,
  runtimeName,
  tarBinary,
  voicePaths,
} from '../src/main/sherpa-installer.js';

const darwin = process.platform === 'darwin';

function recorder() {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    child.kill = (signal) => {
      child.killed = signal;
    };
    children.push(child);
    return child;
  };
  return { calls, children, spawnFn };
}

describe('runtime and voice resolution', () => {
  it('maps every supported platform+arch to a runtime', () => {
    expect(runtimeName('darwin', 'arm64')).toContain('osx-arm64');
    expect(runtimeName('darwin', 'x64')).toContain('osx-x64');
    expect(runtimeName('linux', 'x64')).toContain('linux-x64');
    expect(runtimeName('linux', 'arm64')).toContain('aarch64');
    expect(runtimeName('sunos', 'x64')).toBeNull();
  });

  it('builds kokoro flags for santa and vits flags for faber', () => {
    const santa = voicePaths('/cfg', 'santa', 'linux', 'x64');
    expect(santa.args.some((a) => a.startsWith('--kokoro-model='))).toBe(true);
    expect(santa.args).toContain('--kokoro-lang=pt-br');
    expect(santa.args).toContain('--sid=44');

    const faber = voicePaths('/cfg', 'faber', 'linux', 'x64');
    expect(faber.args.some((a) => a.startsWith('--vits-model='))).toBe(true);
    expect(faber.args.every((a) => !a.includes('kokoro'))).toBe(true);
  });

  it('pins the OS-bundled bsdtar on win32 and plain tar elsewhere', () => {
    expect(tarBinary('linux', {}, () => true)).toBe('tar');
    expect(tarBinary('win32', { SystemRoot: 'C:\\Windows' }, () => true)).toBe(
      'C:\\Windows\\System32\\tar.exe',
    );
    expect(tarBinary('win32', { SystemRoot: 'C:\\Windows' }, () => false)).toBe('tar');
  });

  it('resolves a win32-x64 runtime with an .exe binary', () => {
    const { binary, libDir } = voicePaths('C:\\cfg\\sherpa', 'faber', 'win32', 'x64');
    expect(binary).toMatch(/sherpa-onnx-offline-tts\.exe$/);
    expect(binary).toContain('win-x64-shared');
    expect(libDir).toContain('win-x64-shared');
  });

  it('still resolves the linux binary without a suffix', () => {
    const { binary } = voicePaths('/cfg/sherpa', 'faber', 'linux', 'x64');
    expect(binary).toMatch(/sherpa-onnx-offline-tts$/);
  });

  it('falls back to the default voice for an unknown id', () => {
    const unknown = voicePaths('/cfg', 'nope', 'linux', 'x64');
    expect(unknown.voiceDir).toContain(VOICES[DEFAULT_VOICE].dirName);
  });

  it('needs binary and model to consider a voice installed', () => {
    expect(isVoiceInstalled('/cfg', 'faber', () => true, 'linux', 'x64')).toBe(true);
    const missingModel = (p) => !p.endsWith('.onnx');
    expect(isVoiceInstalled('/cfg', 'faber', missingModel, 'linux', 'x64')).toBe(false);
    expect(isVoiceInstalled('/cfg', 'faber', () => true, 'sunos', 'x64')).toBe(false);
  });
});

describe('speak', () => {
  it('synthesizes with sherpa and plays the wav when the voice is installed', () => {
    const { calls, children, spawnFn } = recorder();
    // accent-free on purpose: the win32 argv encoding is unit-tested on its
    // own (encodeAnsiArgvText) and would rewrite accented args here.
    speak('oi amigo', { voice: 'faber', spawnFn, installed: true });
    expect(calls[0].command).toContain('sherpa-onnx-offline-tts');
    expect(calls[0].args.at(-1)).toBe('oi amigo');
    expect(calls[0].args.some((a) => a.startsWith('--vits-model='))).toBe(true);
    children[0].emit('exit', 0, null);
    expect(calls[1].command).toBe(playerCommand('x.wav', process.platform)[0]);
    stopSpeaking();
  });

  it('uses the system voice and pulls the model when it is missing', () => {
    const { calls, spawnFn } = recorder();
    let asked = null;
    speak('olá', { voice: 'santa', spawnFn, installed: false, ensureFn: (id) => (asked = id) });
    expect(calls[0].command).toBe(systemVoiceCommand('x', 100, process.platform)[0]);
    expect(asked).toBe('santa');
    stopSpeaking();
  });

  it('does not play anything when the synth was killed', () => {
    const { calls, children, spawnFn } = recorder();
    speak('olá', { voice: 'santa', spawnFn, installed: true });
    stopSpeaking();
    expect(children[0].killed).toBe('SIGKILL');
    children[0].emit('exit', null, 'SIGKILL');
    expect(calls).toHaveLength(1);
  });

  it('tells when the line was said, failed or was cut (#161)', () => {
    const played = recorder();
    let done = 0;
    speak('oi', { voice: 'faber', spawnFn: played.spawnFn, installed: true, onDone: () => done++ });
    played.children[0].emit('exit', 0, null);
    expect(done).toBe(0);
    played.children[1].emit('exit', 0, null);
    expect(done).toBe(1);

    const cut = recorder();
    speak('oi', { voice: 'faber', spawnFn: cut.spawnFn, installed: true, onDone: () => done++ });
    stopSpeaking();
    cut.children[0].emit('exit', null, 'SIGKILL');
    expect(done).toBe(2);

    const system = recorder();
    speak('oi', { voice: 'santa', spawnFn: system.spawnFn, installed: false, ensureFn: () => {}, onDone: () => done++ });
    system.children[0].emit('exit', 0, null);
    expect(done).toBe(3);
  });

  it('exposes the sid only for santa', () => {
    const { calls, spawnFn } = recorder();
    speakNeural('olá', 'santa', spawnFn);
    expect(calls[0].args).toContain('--sid=44');
    stopSpeaking();
  });
});

describe('playerCommand', () => {
  it('darwin uses afplay', () => {
    expect(playerCommand('/tmp/x.wav', 'darwin')).toEqual(['afplay', ['/tmp/x.wav']]);
  });
  it('linux uses aplay -q', () => {
    expect(playerCommand('/tmp/x.wav', 'linux')).toEqual(['aplay', ['-q', '/tmp/x.wav']]);
  });
  it('win32 plays through PowerShell SoundPlayer', () => {
    const [command, args] = playerCommand('C:\\t\\x.wav', 'win32');
    expect(command).toBe('powershell.exe');
    expect(args.at(-1)).toContain("Media.SoundPlayer 'C:\\t\\x.wav'");
    expect(args.at(-1)).toContain('PlaySync()');
  });
});

describe('systemVoiceCommand', () => {
  it('win32 speaks through System.Speech with a pt-BR voice when available', () => {
    const [command, args] = systemVoiceCommand('valeu, irmão!', 80, 'win32');
    expect(command).toBe('powershell.exe');
    const script = args.at(-1);
    expect(script).toContain('System.Speech');
    expect(script).toContain('$s.Volume = 80');
    expect(script).toContain('pt-BR');
    expect(script).toContain("Speak('valeu, irmão!')");
  });
  it('darwin still uses say -v Luciana', () => {
    expect(systemVoiceCommand('oi', 100, 'darwin')).toEqual(['say', ['-v', 'Luciana', '--', 'oi']]);
  });
  it('linux still uses spd-say', () => {
    expect(systemVoiceCommand('oi', 100, 'linux')).toEqual([
      'spd-say',
      ['-l', 'pt-BR', '-i', '100', '--', 'oi'],
    ]);
  });
});

describe('predownloadVoice', () => {
  it('kicks the download of the chosen voice without waiting for a speak', () => {
    const ensured = [];
    expect(predownloadVoice('santa', { ensureFn: (id) => ensured.push(id) })).toBe(true);
    expect(ensured).toEqual(['santa']);
  });

  it('falls back to the default voice when the id is unknown', () => {
    const ensured = [];
    predownloadVoice('typo', { ensureFn: (id) => ensured.push(id) });
    expect(ensured).toEqual([DEFAULT_VOICE]);
  });

  it('downloads nothing while TTS is turned off — 350MB need an opt-in', () => {
    const ensured = [];
    expect(predownloadVoice('santa', { enabled: false, ensureFn: (id) => ensured.push(id) })).toBe(
      false,
    );
    expect(ensured).toEqual([]);
  });
});


// Issue #71: the pt-BR voices read "Vizor" as written (vi-ZOR); the brand is
// pronounced like the English "visor". Speech-only fix — displays keep Vizor.
describe('speakableText', () => {
  it('respells Vizor so the pt-BR voice says vaizor', () => {
    expect(speakableText('O Vizor se atualizou!')).toBe('O Váizor se atualizou!');
  });

  it('catches any casing, as a whole word, anywhere in the phrase', () => {
    expect(speakableText('vizor, VIZOR e Vizor')).toBe('Váizor, Váizor e Váizor');
  });

  it('never touches Vizor inside another word', () => {
    expect(speakableText('supervizor de plantão')).toBe('supervizor de plantão');
  });

  // The shim sits inside speak(), so DYNAMIC text is covered too: a folder
  // literally named "vizor" arriving via projectName comes out right.
  it('fixes the pronunciation in dynamic text like folder names', () => {
    const projectName = 'vizor'; // basename of ~/vizor
    expect(speakableText(`Tarefa concluída no ${projectName}.`)).toBe(
      'Tarefa concluída no Váizor.',
    );
    expect(speakableText(`O chat vizor espera você.`)).toBe('O chat Váizor espera você.');
  });
});
