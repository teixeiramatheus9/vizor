import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { playerCommand,
  predownloadVoice,
  setAudioOutput,
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

  it('builds kokoro flags for santa and supertonic flags for clara and davi', () => {
    const santa = voicePaths('/cfg', 'santa', 'linux', 'x64');
    expect(santa.args.some((a) => a.startsWith('--kokoro-model='))).toBe(true);
    expect(santa.args).toContain('--kokoro-lang=pt-br');
    expect(santa.args).toContain('--sid=44');

    const clara = voicePaths('/cfg', 'clara', 'linux', 'x64');
    const davi = voicePaths('/cfg', 'davi', 'linux', 'x64');
    expect(clara.args.some((a) => a.startsWith('--supertonic-text-encoder='))).toBe(true);
    expect(clara.args).toContain('--lang=pt');
    expect(clara.args).toContain('--sid=0');
    expect(davi.args).toContain('--sid=8');
    expect(davi.voiceDir).toBe(clara.voiceDir); // one model, two speakers
  });

  it('each voice runs on its own runtime: Supertonic needs 2.0.0, Kokoro pt-br the 1.x espeak build', () => {
    expect(voicePaths('/cfg', 'clara', 'linux', 'x64').binary).toContain('sherpa-onnx-v2.0.0-linux-x64-shared');
    expect(voicePaths('/cfg', 'davi', 'win32', 'x64').binary).toContain('sherpa-onnx-v2.0.0-win-x64-shared-MT-Release');
    expect(voicePaths('/cfg', 'santa', 'linux', 'x64').binary).toContain('sherpa-onnx-v1.13.6-linux-x64-shared');
    expect(runtimeName('darwin', 'arm64', 'v2.0.0')).toBe('sherpa-onnx-v2.0.0-onnxruntime-1.17.1-osx-arm64-shared');
  });

  it('the ten Supertonic speakers also speak American English, from the same model', () => {
    const english = Object.entries(VOICES).filter(([, voice]) => voice.lang === 'en');
    expect(english.map(([id]) => id)).toEqual(['en-0', 'en-1', 'en-2', 'en-3', 'en-4', 'en-5', 'en-6', 'en-7', 'en-8', 'en-9']);
    const voice = voicePaths('/cfg', 'en-3', 'linux', 'x64');
    expect(voice.args).toContain('--lang=en');
    expect(voice.args).toContain('--sid=3');
    expect(voice.voiceDir).toBe(voicePaths('/cfg', 'clara', 'linux', 'x64').voiceDir);
    expect(VOICES.clara.lang).toBe('pt');
    expect(VOICES.santa.lang).toBe('pt');
  });

  it('speechLang: the language the Vizor speaks with a voice', async () => {
    const { speechLang } = await import('../src/main/sherpa-installer.js');
    expect(speechLang('en-5')).toBe('en');
    expect(speechLang('clara')).toBe('pt');
    expect(speechLang('santa')).toBe('pt');
    expect(speechLang('faber')).toBe('pt'); // a dropped voice speaks as the default
  });

  it('Clara is the default and Faber is gone (#161: the user rejected it)', () => {
    expect(DEFAULT_VOICE).toBe('clara');
    expect(VOICES.faber).toBeUndefined();
  });

  it('pins the OS-bundled bsdtar on win32 and plain tar elsewhere', () => {
    expect(tarBinary('linux', {}, () => true)).toBe('tar');
    expect(tarBinary('win32', { SystemRoot: 'C:\\Windows' }, () => true)).toBe(
      'C:\\Windows\\System32\\tar.exe',
    );
    expect(tarBinary('win32', { SystemRoot: 'C:\\Windows' }, () => false)).toBe('tar');
  });

  it('resolves a win32-x64 runtime with an .exe binary', () => {
    const { binary, libDir } = voicePaths('C:\\cfg\\sherpa', 'clara', 'win32', 'x64');
    expect(binary).toMatch(/sherpa-onnx-offline-tts\.exe$/);
    expect(binary).toContain('win-x64-shared');
    expect(libDir).toContain('win-x64-shared');
  });

  it('still resolves the linux binary without a suffix', () => {
    const { binary } = voicePaths('/cfg/sherpa', 'clara', 'linux', 'x64');
    expect(binary).toMatch(/sherpa-onnx-offline-tts$/);
  });

  it('falls back to the default voice for an unknown id', () => {
    const unknown = voicePaths('/cfg', 'nope', 'linux', 'x64');
    expect(unknown.voiceDir).toContain(VOICES[DEFAULT_VOICE].dirName);
  });

  it('needs binary and model to consider a voice installed', () => {
    expect(isVoiceInstalled('/cfg', 'clara', () => true, 'linux', 'x64')).toBe(true);
    const missingModel = (p) => !p.endsWith('.onnx');
    expect(isVoiceInstalled('/cfg', 'clara', missingModel, 'linux', 'x64')).toBe(false);
    expect(isVoiceInstalled('/cfg', 'clara', () => true, 'sunos', 'x64')).toBe(false);
  });
});

describe('speak', () => {
  it('synthesizes with sherpa and plays the wav when the voice is installed', () => {
    const { calls, children, spawnFn } = recorder();
    // accent-free on purpose: the win32 argv encoding is unit-tested on its
    // own (encodeAnsiArgvText) and would rewrite accented args here.
    speak('oi amigo', { voice: 'clara', spawnFn, installed: true });
    expect(calls[0].command).toContain('sherpa-onnx-offline-tts');
    expect(calls[0].args.at(-1)).toBe('oi amigo');
    expect(calls[0].args.some((a) => a.startsWith('--supertonic-voice-style='))).toBe(true);
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
    speak('oi', { voice: 'clara', spawnFn: played.spawnFn, installed: true, onDone: () => done++ });
    played.children[0].emit('exit', 0, null);
    expect(done).toBe(0);
    played.children[1].emit('exit', 0, null);
    expect(done).toBe(1);

    const cut = recorder();
    speak('oi', { voice: 'clara', spawnFn: cut.spawnFn, installed: true, onDone: () => done++ });
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
  it('linux still uses spd-say, waiting until it was said (#161: the voice mode must not hear itself)', () => {
    expect(systemVoiceCommand('oi', 100, 'linux')).toEqual([
      'spd-say',
      ['-w', '-l', 'pt-BR', '-i', '100', '--', 'oi'],
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

describe('dev terms said the way Brazilian devs say them (#161)', () => {
  it("Santa: the user's own references, GitHub and PR", () => {
    expect(speakableText('Tem 2 PRs e 1 PR no GitHub.', 'santa')).toBe('Tem 2 pê érres e 1 pê érre no guitirrube.');
    expect(speakableText('A task 22 tem 3 issues e uma pull request.', 'santa')).toBe('A tésqui 22 tem 3 íchus e uma pul riquésti.');
  });

  it('Supertonic says most terms right as written; only a few are respelled', () => {
    expect(speakableText('No GitHub tem 2 PRs e 1 PR, e 3 issues.', 'clara')).toBe('No GitHub tem 2 peérris e 1 PR, e 3 issues.');
    expect(speakableText('Dois bugs no frontend e no backend.', 'davi')).toBe('Dois bugs no front-êndi e no béqui-êndi.');
    expect(speakableText('Mexi no front e no back.', 'clara')).toBe('Mexi no fronti e no béqui.');
    expect(speakableText('O front-end e o back-end.', 'clara')).toBe('O front-êndi e o béqui-êndi.');
    expect(speakableText('Fiz o review de 2 tasks e 1 task.', 'davi')).toBe('Fiz o rêvíu de 2 téskís e 1 téskí.');
  });

  it('Supertonic: "a" and "pra" before a term stay Portuguese (a double space keeps them apart)', () => {
    expect(speakableText('A feature tem dois bugs.', 'clara')).toBe('A  feature tem dois bugs.');
    expect(speakableText('Abri uma pull request pra main.', 'davi')).toBe('Abri uma pull request pra  main.');
    expect(speakableText('Vou pra casa e a gente vê.', 'clara')).toBe('Vou pra casa e a gente vê.');
  });

  it('English voices get the text as is: no pt-BR respelling at all', () => {
    expect(speakableText('A task on GitHub has two PRs, ask Vizor.', 'en-0')).toBe('A task on GitHub has two PRs, ask Vizor.');
  });

  it('only whole words, and the brand still respelled', () => {
    expect(speakableText('o maintainer fez rebuild no Vizor', 'santa')).toBe('o maintainer fez rebuild no Váizor');
    expect(speakableText('PRESSA não é PR', 'santa')).toBe('PRESSA não é pê érre');
    expect(speakableText('o Vizor e o frontender', 'clara')).toBe('o Váizor e o frontender');
  });
});

describe('the system voice speaks the chosen voice language while the model downloads', () => {
  it('English: an en-US voice on every platform', () => {
    expect(systemVoiceCommand('hi', 100, 'linux', true, 'en')[1]).toEqual(['-w', '-l', 'en-US', '-i', '100', '--', 'hi']);
    expect(systemVoiceCommand('hi', 100, 'darwin', true, 'en')[1]).toEqual(['-v', 'Samantha', '--', 'hi']);
    expect(systemVoiceCommand('hi', 100, 'win32', true, 'en')[1].at(-1)).toContain("Culture.Name -eq 'en-US'");
    expect(systemVoiceCommand('oi', 100, 'linux')[1]).toEqual(['-w', '-l', 'pt-BR', '-i', '100', '--', 'oi']);
  });

  it('speak() hands the language to the fallback', () => {
    const { calls, spawnFn } = recorder();
    speak('hello', { voice: 'en-2', spawnFn, installed: false, ensureFn: () => {} });
    const expected = systemVoiceCommand('hello', 100, process.platform, true, 'en');
    expect(calls[0].command).toBe(expected[0]);
    expect(calls[0].args).toEqual(expected[1]);
    stopSpeaking();
  });
});

describe('the voice plays on the chosen output (tray menu › saída de áudio)', () => {
  it('linux: pw-play on the pinned sink; aplay on the system default; other platforms unchanged', () => {
    expect(playerCommand('/t/x.wav', 'linux', { name: 'alsa_output.usb.h510', label: 'H510' })).toEqual(['pw-play', ['--target', 'alsa_output.usb.h510', '/t/x.wav']]);
    expect(playerCommand('/t/x.wav', 'linux', null)).toEqual(['aplay', ['-q', '/t/x.wav']]);
    expect(playerCommand('/t/x.wav', 'darwin', { name: 'x', label: 'x' })).toEqual(['afplay', ['/t/x.wav']]);
  });
});

describe('setAudioOutput', () => {
  it('the neural voice plays on the pinned output until it is cleared', () => {
    const { calls, children, spawnFn } = recorder();
    setAudioOutput({ name: 'alsa_output.usb.h510', label: 'H510' });
    speak('oi', { voice: 'clara', spawnFn, installed: true });
    children[0].emit('exit', 0, null);
    expect(calls[1]).toMatchObject(process.platform === 'linux' ? { command: 'pw-play', args: ['--target', 'alsa_output.usb.h510', expect.any(String)] } : {});
    setAudioOutput(null);
    stopSpeaking();
  });
});
