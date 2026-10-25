import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_VOICE, VOICES, installVoice, isVoiceInstalled, runtimeName, voicePaths } from './sherpa-installer.js';
import { encodeAnsiArgvText, psQuote, readAnsiCodepage } from './win32-native.js';
import { applyGain } from './wav-gain.js';
import { configDir } from './paths.js';
import { log } from './log.js';

const darwin = process.platform === 'darwin';
const sherpaDir = path.join(configDir, 'sherpa');
const legacyPiperDir = path.join(configDir, 'piper');
const downloading = new Set();
let processes = [];
let onDownloadStatus = () => {};

// The renderer shows a line while a model is on its way.
export function watchDownloads(listener) {
  onDownloadStatus = listener;
}

export function downloadingVoice() {
  return [...downloading][0] ?? null;
}

export function stopSpeaking() {
  for (const child of processes) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
  processes = [];
}

// Pure command builders so every platform's spawn line is unit-testable.
export function playerCommand(wavFile, platform = process.platform) {
  if (platform === 'darwin') return ['afplay', [wavFile]];
  if (platform === 'win32') {
    return [
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object Media.SoundPlayer ${psQuote(wavFile)}).PlaySync()`,
      ],
    ];
  }
  return ['aplay', ['-q', wavFile]];
}

export function systemVoiceCommand(text, volume, platform = process.platform, useVoiceFlag = true) {
  if (platform === 'darwin') {
    // `say` takes the volume inline.
    const spoken = volume < 100 ? `[[volm ${(volume / 100).toFixed(2)}]]${text}` : text;
    return ['say', useVoiceFlag ? ['-v', 'Luciana', '--', spoken] : ['--', spoken]];
  }
  if (platform === 'win32') {
    const level = Math.max(0, Math.min(100, Math.round(volume)));
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$s.Volume = ${level}`,
      "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1",
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
      `$s.Speak(${psQuote(text)})`,
    ].join('; ');
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]];
  }
  // spd-say wants -100..100.
  // -w: exits only once the line was said, so onDone means silence.
  return ['spd-say', ['-w', '-l', 'pt-BR', '-i', String(Math.round(volume * 2 - 100)), '--', text]];
}

// The system voice covers the gap while a model downloads.
// onDone fires once, when the line was said, failed or was cut (#161: the
// voice mode must know when the Vizor stops talking).
function once(callback) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

function speakWithSystemVoice(text, spawnFn, volume = 100, useVoiceFlag = true, onDone = () => {}) {
  const done = once(onDone);
  const [command, args] = systemVoiceCommand(text, volume, process.platform, useVoiceFlag);
  const child = spawnFn(command, args, { stdio: 'ignore' });
  child.on('error', (error) => {
    log(`${command} failed: ${error}`);
    done();
  });
  child.on('exit', (code, signal) => {
    if (darwin && useVoiceFlag && code !== 0 && code !== null && !signal) {
      speakWithSystemVoice(text, spawnFn, volume, false, done);
      return;
    }
    done();
  });
  processes = [child];
}

// sherpa reads its argv as UTF-8 but the Windows CRT hands it over in the
// ANSI codepage, so accents arrive corrupted and get SPOKEN as garbage
// syllables ("concluída" -> "conclu-ã-í-da"). encodeAnsiArgvText undoes that;
// the codepage is read once and cached.
let cachedAnsiCodepage = null;

function neuralArgvText(text) {
  if (process.platform !== 'win32') return text;
  cachedAnsiCodepage ??= readAnsiCodepage(execFileSync);
  return encodeAnsiArgvText(text, cachedAnsiCodepage);
}

// sherpa-onnx has no raw-audio streaming mode, so it renders a wav and the
// system player plays it.
export function speakNeural(text, voiceId, spawnFn = spawn, volume = 100, onDone = () => {}) {
  const done = once(onDone);
  const { binary, libDir, args } = voicePaths(sherpaDir, voiceId);
  const wavFile = path.join(os.tmpdir(), 'vizor-tts.wav');
  const env = { ...process.env, DYLD_LIBRARY_PATH: libDir, LD_LIBRARY_PATH: libDir };
  if (process.platform === 'win32') {
    // Windows finds DLLs through PATH, not LD_LIBRARY_PATH.
    env.PATH = `${libDir};${path.dirname(binary)};${env.PATH ?? ''}`;
  }
  const synth = spawnFn(
    binary,
    [...args, '--num-threads=4', `--output-filename=${wavFile}`, neuralArgvText(text)],
    { env, stdio: 'ignore' },
  );
  processes = [synth];
  synth.on('error', (error) => {
    log(`sherpa failed: ${error}`);
    done();
  });
  synth.on('exit', (code, signal) => {
    if (code !== 0 || signal) {
      done();
      return;
    }
    if (volume < 100) {
      try {
        fs.writeFileSync(wavFile, applyGain(fs.readFileSync(wavFile), volume));
      } catch (error) {
        log(`gain failed: ${error}`);
      }
    }
    const [playCommand, playArgs] = playerCommand(wavFile);
    const player = spawnFn(playCommand, playArgs, { stdio: 'ignore' });
    processes = [player];
    player.on('error', (error) => {
      log(`player failed: ${error}`);
      done();
    });
    player.on('exit', done);
  });
}

function ensureVoiceInBackground(voiceId) {
  if (!runtimeName()) return; // no sherpa build for this platform — system voice only
  if (downloading.has(voiceId) || isVoiceInstalled(sherpaDir, voiceId)) return;
  downloading.add(voiceId);
  onDownloadStatus(voiceId);
  log(`voice: downloading ${voiceId}…`);
  installVoice(sherpaDir, voiceId)
    .then(() => {
      log(`voice: ${voiceId} installed`);
      downloading.delete(voiceId);
      onDownloadStatus(null);
      fs.rmSync(legacyPiperDir, { recursive: true, force: true });
      speakNeural('Voz instalada. Agora eu falo assim!', voiceId);
    })
    .catch((error) => {
      downloading.delete(voiceId); // allow a retry on the next speak
      onDownloadStatus(null);
      log(`voice install failed: ${error}`);
    });
}

// Pulls the chosen voice down as soon as the app is up instead of on the
// first spoken line — a fresh install otherwise greets the user with the
// system fallback voice. Idempotent and quiet: ensureVoiceInBackground skips
// installed or in-flight voices and swallows failures (the next speak retries).
export function predownloadVoice(voiceId, { enabled = true, ensureFn = ensureVoiceInBackground } = {}) {
  if (!enabled) return false;
  ensureFn(VOICES[voiceId] ? voiceId : DEFAULT_VOICE);
  return true;
}

// The brand is pronounced like the English "visor" ("váizor"), but pt-BR
// voices read the spelling literally. Respell it for SPEECH only — every
// displayed surface keeps "Vizor" (issue #71).
// Dev words are said in English (#161): pt-BR voices read "GitHub" as
// "Jite Chob" and "issues" as "SUS". Each spelling was checked by speaking it
// with that voice and transcribing it back; the voices differ, so each has
// its own column. Speech only — every displayed surface keeps the real word.
const DEV_WORDS = [
  [/\bgithub\b/gi, 'guíti ráb', 'guíti ráb'],
  [/\bissues\b/gi, 'íchius', 'íchius'],
  [/\bissue\b/gi, 'íchiu', 'íchiu'],
  [/\bpull requests\b/gi, 'pul requésts', 'púl ri-qués'],
  [/\bpull request\b/gi, 'pul requést', 'púl ri-quést'],
  [/\bbranches\b/gi, 'brénchis', 'brântchis'],
  [/\bbranch\b/gi, 'brénch', 'brântch'],
  [/\bpush\b/gi, 'púch', 'púch'],
  [/\bdeploy\b/gi, 'diplói', 'diplói'],
  [/\bbuild\b/gi, 'bíuld', 'bilde'],
  [/\breview\b/gi, 'riviú', 'riviú'],
  [/\bfeatures?\b/gi, 'fítcher', 'fítcher'],
  [/\bmain\b/gi, 'mêin', 'mêin'],
  [/\btasks?\b/gi, 'tâsk', null],
  [/\bworktrees?\b/gi, 'uórc trí', 'uôrc tri'],
  [/\bCI\b/g, 'si-ái', 'si-ái'],
];

export function speakableText(text, voiceId = DEFAULT_VOICE) {
  let speech = String(text ?? '').replace(/\bvizor\b/gi, 'Váizor');
  const column = voiceId === 'faber' ? 2 : 1;
  for (const entry of DEV_WORDS) if (entry[column]) speech = speech.replace(entry[0], entry[column]);
  return speech;
}

export function speak(
  text,
  {
    voice = DEFAULT_VOICE,
    volume = 100,
    spawnFn = spawn,
    installed = null,
    ensureFn = ensureVoiceInBackground,
    onDone = () => {},
  } = {},
) {
  if (volume <= 0) {
    onDone();
    return;
  }
  const voiceId = VOICES[voice] ? voice : DEFAULT_VOICE;
  const speech = speakableText(text, voiceId);
  const ready = installed ?? isVoiceInstalled(sherpaDir, voiceId);
  if (ready) {
    speakNeural(speech, voiceId, spawnFn, volume, onDone);
    return;
  }
  speakWithSystemVoice(speech, spawnFn, volume, true, onDone);
  ensureFn(voiceId);
}
