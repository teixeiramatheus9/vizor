import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import unbzip2 from 'unbzip2-stream';

// Kokoro pt-br needs the 1.x build: 2.0.0 dropped espeak-ng, its phonemizer.
// Supertonic needs 2.0.0: 1.x synthesizes the whole text in one pass, with no
// pause between sentences and the pace dragging after each English word.
const KOKORO_RUNTIME = 'v1.13.6';
const SUPERTONIC_RUNTIME = 'v2.0.0';
const releaseBase = (version) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/${version}`;
const MODELS_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';

// One runtime per platform+arch; the mac arm64 build is the only one whose
// asset name carries the onnxruntime version.
const RUNTIMES = {
  'darwin-arm64': (version) => `sherpa-onnx-${version}-onnxruntime-1.17.1-osx-arm64-shared`,
  'darwin-x64': (version) => `sherpa-onnx-${version}-osx-x64-shared`,
  'linux-x64': (version) => `sherpa-onnx-${version}-linux-x64-shared`,
  'linux-arm64': (version) => `sherpa-onnx-${version}-linux-aarch64-shared-cpu`,
  // MT = static CRT: no MSVC runtime redistributable needed on the user's box.
  'win32-x64': (version) => `sherpa-onnx-${version}-win-x64-shared-MT-Release`,
};

export const VOICES = {
  santa: {
    label: 'Santa',
    lang: 'pt',
    runtime: KOKORO_RUNTIME,
    dirName: 'kokoro-multi-lang-v1_0',
    modelFile: 'model.onnx',
    args: (dir) => [
      `--kokoro-model=${path.join(dir, 'model.onnx')}`,
      `--kokoro-voices=${path.join(dir, 'voices.bin')}`,
      `--kokoro-tokens=${path.join(dir, 'tokens.txt')}`,
      `--kokoro-data-dir=${path.join(dir, 'espeak-ng-data')}`,
      '--kokoro-lang=pt-br',
      '--sid=44',
    ],
  },
  // Supertonic (#161): one 95 MB model, several speakers; the user picked
  // 0 and 8 by ear (4 and 9 sound European). Faber was dropped: it mangled
  // every dev word.
  clara: supertonic('Clara', 0),
  davi: supertonic('Davi', 8),
  // The same speakers in American English, for whoever prefers to hear the
  // Vizor in English; all ten kept, the user's call.
  ...Object.fromEntries(Array.from({ length: 10 }, (_, sid) => [`en-${sid}`, supertonic(`Inglês (EUA) ${sid + 1}`, sid, 'en')])),
};

function supertonic(label, sid, lang = 'pt') {
  const file = (dir, name) => path.join(dir, name);
  return {
    label,
    engine: 'supertonic',
    lang,
    runtime: SUPERTONIC_RUNTIME,
    dirName: 'sherpa-onnx-supertonic-tts-int8-2026-03-06',
    modelFile: 'text_encoder.int8.onnx',
    args: (dir) => [
      `--supertonic-duration-predictor=${file(dir, 'duration_predictor.int8.onnx')}`,
      `--supertonic-text-encoder=${file(dir, 'text_encoder.int8.onnx')}`,
      `--supertonic-vector-estimator=${file(dir, 'vector_estimator.int8.onnx')}`,
      `--supertonic-vocoder=${file(dir, 'vocoder.int8.onnx')}`,
      `--supertonic-tts-json=${file(dir, 'tts.json')}`,
      `--supertonic-unicode-indexer=${file(dir, 'unicode_indexer.bin')}`,
      `--supertonic-voice-style=${file(dir, 'voice.bin')}`,
      `--lang=${lang}`,
      `--sid=${sid}`,
      '--num-steps=8',
    ],
  };
}

export const DEFAULT_VOICE = 'clara';

// What the Vizor speaks follows the voice (#161): an English voice hears
// English back while the user keeps speaking Portuguese.
export function speechLang(voiceId) {
  return (VOICES[voiceId] ?? VOICES[DEFAULT_VOICE]).lang;
}

export function runtimeName(platform = process.platform, arch = process.arch, version = VOICES[DEFAULT_VOICE].runtime) {
  return RUNTIMES[`${platform}-${arch}`]?.(version) ?? null;
}

export function voicePaths(sherpaDir, voiceId, platform = process.platform, arch = process.arch) {
  const voice = VOICES[voiceId] ?? VOICES[DEFAULT_VOICE];
  const runtime = runtimeName(platform, arch, voice.runtime);
  const runtimeDir = runtime ? path.join(sherpaDir, runtime) : null;
  const voiceDir = path.join(sherpaDir, voice.dirName);
  return {
    runtimeDir,
    binary: runtimeDir
      ? path.join(
          runtimeDir,
          'bin',
          platform === 'win32' ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts',
        )
      : null,
    libDir: runtimeDir ? path.join(runtimeDir, 'lib') : null,
    voiceDir,
    model: path.join(voiceDir, voice.modelFile),
    args: voice.args(voiceDir),
  };
}

export function isVoiceInstalled(sherpaDir, voiceId, existsFn = fs.existsSync, platform, arch) {
  const { binary, model } = voicePaths(sherpaDir, voiceId, platform, arch);
  return Boolean(binary) && existsFn(binary) && existsFn(model);
}

async function download(url, destination, fetchFn) {
  const response = await fetchFn(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

// Streamed to disk with progress: the voice models are hundreds of MB, too
// big to hold in memory and too slow to download in silence (#161).
export async function downloadFile(url, destination, onProgress = () => {}, fetchFn = fetch) {
  const response = await fetchFn(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  const total = Number(response.headers.get('content-length')) || null;
  const out = fs.createWriteStream(destination);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress({ received, total });
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

// Git Bash puts MSYS GNU tar first on PATH, and that tar mangles Windows
// `-C C:\...` paths; the OS-bundled bsdtar handles them, so win32 pins it.
export function tarBinary(platform = process.platform, env = process.env, existsFn = fs.existsSync) {
  if (platform !== 'win32') return 'tar';
  // win32 separators regardless of the OS running this — the platform comes
  // in as an argument, so tests exercise this branch from any machine.
  const systemTar = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsFn(systemTar) ? systemTar : 'tar';
}

// bzip2 is decompressed in pure JS and streamed into `tar -xf -`, so the
// system needs no bzip2 binary (tar -xjf shells out to it and many machines
// don't have it — that broke voice installs with "tar exited with 2").
export function extractTarBz2(archive, directory, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const tar = spawnFn(tarBinary(), ['-xf', '-', '-C', directory], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    tar.on('error', reject);
    tar.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)),
    );
    if (!tar.stdin) {
      resolve(); // test double without stdin — nothing to stream
      return;
    }
    fs.createReadStream(archive)
      .on('error', reject)
      .pipe(unbzip2())
      .on('error', reject)
      .pipe(tar.stdin)
      .on('error', reject);
  });
}

// Installs run one at a time: Clara, Davi and the English voices share one
// model and one runtime, and two picks in a row would download and extract
// the same archives at once (review). The second finds the files in place.
let installs = Promise.resolve();

export function installVoice(sherpaDir, voiceId, options = {}) {
  const run = installs.then(() => installNow(sherpaDir, voiceId, options));
  installs = run.catch(() => {});
  return run;
}

// Downloads the sherpa-onnx runtime (once) and the chosen voice model.
async function installNow(sherpaDir, voiceId, { fetchFn = fetch, spawnFn = spawn } = {}) {
  const voice = VOICES[voiceId] ?? VOICES[DEFAULT_VOICE];
  const runtime = runtimeName(process.platform, process.arch, voice.runtime);
  if (!runtime) throw new Error(`no sherpa build for ${process.platform}-${process.arch}`);
  fs.mkdirSync(sherpaDir, { recursive: true });
  const { binary, model } = voicePaths(sherpaDir, voiceId);

  for (const [target, url, name] of [
    [binary, `${releaseBase(voice.runtime)}/${runtime}.tar.bz2`, `${runtime}.tar.bz2`],
    [model, `${MODELS_BASE}/${voice.dirName}.tar.bz2`, `${voice.dirName}.tar.bz2`],
  ]) {
    if (fs.existsSync(target)) continue;
    const archive = path.join(sherpaDir, name);
    await download(url, archive, fetchFn);
    await extractTarBz2(archive, sherpaDir, spawnFn);
    fs.rmSync(archive, { force: true });
  }
  return isVoiceInstalled(sherpaDir, voiceId);
}
