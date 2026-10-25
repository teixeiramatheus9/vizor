import fs from 'node:fs';
import path from 'node:path';
import { downloadFile, extractTarBz2 } from '../sherpa-installer.js';

// The listening models (#161), downloaded when the user turns voice on —
// never packaged. Sizes are the download, for the warning shown before it.
const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const KWS_MODEL = {
  id: 'kws',
  url: `${RELEASES}/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
  dirName: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
  files: [
    'tokens.txt',
    'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  ],
  approxMB: 18,
};

export const VAD_MODEL = {
  id: 'vad',
  url: `${RELEASES}/asr-models/silero_vad.onnx`,
  dirName: 'silero-vad',
  files: ['silero_vad.onnx'],
  single: true,
  approxMB: 1,
};

const whisper = (size, approxMB) => ({
  id: `asr-${size}`,
  kind: 'whisper',
  url: `${RELEASES}/asr-models/sherpa-onnx-whisper-${size}.tar.bz2`,
  dirName: `sherpa-onnx-whisper-${size}`,
  prefix: size,
  files: [`${size}-encoder.int8.onnx`, `${size}-decoder.int8.onnx`, `${size}-tokens.txt`],
  approxMB,
});

// Measured on the user's own recorded phrases (pt-BR with code words):
// Parakeet v3 22.5% WER at ~0.6 s, Whisper base 39.6% at ~0.8 s, small
// 32.4% at ~1.8 s. Parakeet is the default; base is the light option.
const PARAKEET = {
  id: 'asr-parakeet',
  kind: 'parakeet',
  url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
  dirName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  prefix: null,
  files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
  approxMB: 480,
};

export const ASR_MODELS = { parakeet: PARAKEET, base: whisper('base', 208) };

// The English spotter's spellings of how "Vizor" is said (the spike heard
// the user's "Vizor" as these). One per line, sherpa's keywords format.
export const KEYWORDS = ['▁VI S OR @VIZOR', '▁VI Z OR @VIZOR', '▁VA I Z OR @VIZOR', '▁VA I S OR @VIZOR'].join('\n') + '\n';

const asrOf = (model) => ASR_MODELS[model] ?? ASR_MODELS.parakeet;
const modelsFor = (model) => [KWS_MODEL, VAD_MODEL, asrOf(model)];

export function voiceModelPaths(sherpaDir, model) {
  const asr = asrOf(model);
  return {
    kws: { dir: path.join(sherpaDir, KWS_MODEL.dirName), keywordsFile: path.join(sherpaDir, 'voz', 'keywords.txt') },
    vad: path.join(sherpaDir, VAD_MODEL.dirName, VAD_MODEL.files[0]),
    asr: { dir: path.join(sherpaDir, asr.dirName), prefix: asr.prefix, kind: asr.kind },
  };
}

export function missingVoiceModels(sherpaDir, model, exists = fs.existsSync) {
  return modelsFor(model)
    .filter((entry) => entry.files.some((file) => !exists(path.join(sherpaDir, entry.dirName, file))))
    .map((entry) => entry.id);
}

// Each model goes to a .tmp dir first and is renamed into place only when
// complete: a broken download never looks installed. The archives also hold
// the fp32 weights; only the int8 ones are kept.
export async function installVoiceModels(
  sherpaDir,
  model,
  { download = downloadFile, extract = extractTarBz2, onProgress = () => {} } = {},
) {
  fs.mkdirSync(sherpaDir, { recursive: true });
  for (const entry of modelsFor(model)) {
    if (missingVoiceModels(sherpaDir, model).indexOf(entry.id) === -1) continue;
    const tmp = path.join(sherpaDir, `.tmp-${entry.id}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const report = (event) => onProgress({ id: entry.id, ...event });
      if (entry.single) {
        fs.mkdirSync(path.join(tmp, entry.dirName), { recursive: true });
        await download(entry.url, path.join(tmp, entry.dirName, entry.files[0]), report);
      } else {
        const archive = path.join(tmp, 'model.tar.bz2');
        await download(entry.url, archive, report);
        await extract(archive, tmp);
        fs.rmSync(archive, { force: true });
        for (const file of fs.readdirSync(path.join(tmp, entry.dirName))) {
          if (!entry.files.includes(file)) fs.rmSync(path.join(tmp, entry.dirName, file), { recursive: true, force: true });
        }
      }
      const target = path.join(sherpaDir, entry.dirName);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(path.join(tmp, entry.dirName), target);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.join(sherpaDir, 'voz'), { recursive: true });
  fs.writeFileSync(path.join(sherpaDir, 'voz', 'keywords.txt'), KEYWORDS);
}
