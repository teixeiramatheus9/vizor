import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASR_MODELS, KEYWORDS, installVoiceModels, missingVoiceModels, voiceModelPaths } from '../src/main/voice/models.js';
import { downloadFile } from '../src/main/sherpa-installer.js';

describe('voice model paths', () => {
  it('Parakeet v3 is the default model, Whisper base the light one (live test)', () => {
    expect(voiceModelPaths('/s', 'parakeet').asr).toEqual({ dir: '/s/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', prefix: null, kind: 'parakeet' });
    expect(voiceModelPaths('/s', 'nope').asr.kind).toBe('parakeet');
    expect(Object.keys(ASR_MODELS)).toEqual(['parakeet', 'base']);
    expect(missingVoiceModels('/s', 'parakeet', () => false)).toEqual(['kws', 'vad', 'asr-parakeet']);
  });

  it('gives the engine its paths for base', () => {
    const base = voiceModelPaths('/s', 'base');
    expect(base.asr).toEqual({ dir: '/s/sherpa-onnx-whisper-base', prefix: 'base', kind: 'whisper' });
    expect(base.kws.dir).toBe('/s/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01');
    expect(base.kws.keywordsFile).toBe('/s/voz/keywords.txt');
    expect(base.vad).toBe('/s/silero-vad/silero_vad.onnx');
    expect(ASR_MODELS.base.approxMB).toBeLessThan(ASR_MODELS.parakeet.approxMB);
  });

  it('lists only what is missing', () => {
    const present = new Set(['/s/silero-vad/silero_vad.onnx']);
    expect(missingVoiceModels('/s', 'base', (file) => present.has(file))).toEqual(['kws', 'asr-base']);
  });

  it('the keyword file spells Vizor the ways the spike heard it', () => {
    expect(KEYWORDS.split('\n').filter(Boolean)).toEqual([
      '▁VI S OR @VIZOR',
      '▁VI Z OR @VIZOR',
      '▁VA I Z OR @VIZOR',
      '▁VA I S OR @VIZOR',
    ]);
  });
});

describe('installVoiceModels', () => {
  let dir;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzmodels-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fakeExtract = (files) => async (_archive, into) => {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(into, file)), { recursive: true });
      fs.writeFileSync(path.join(into, file), 'x');
    }
  };

  it('installs everything, keeps only the int8 files, and writes the keywords', async () => {
    const progress = [];
    await installVoiceModels(dir, 'base', {
      download: async (_url, destination, onProgress) => {
        onProgress({ received: 1, total: 2 });
        onProgress({ received: 2, total: 2 });
        fs.writeFileSync(destination, 'archive');
      },
      extract: async (archive, into) => {
        if (archive.includes('kws')) await fakeExtract(['sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/tokens.txt', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/encoder-epoch-12-avg-2-chunk-16-left-64.onnx'])(archive, into);
        else await fakeExtract(['sherpa-onnx-whisper-base/base-encoder.int8.onnx', 'sherpa-onnx-whisper-base/base-encoder.onnx', 'sherpa-onnx-whisper-base/base-tokens.txt'])(archive, into);
      },
      onProgress: (event) => progress.push(event),
    });
    expect(fs.existsSync(path.join(dir, 'sherpa-onnx-whisper-base', 'base-encoder.int8.onnx'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sherpa-onnx-whisper-base', 'base-encoder.onnx'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'silero-vad', 'silero_vad.onnx'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'voz', 'keywords.txt'), 'utf8')).toBe(KEYWORDS);
    expect(progress.at(-1)).toMatchObject({ received: 2, total: 2 });
    expect(new Set(progress.map((event) => event.id))).toEqual(new Set(['kws', 'vad', 'asr-base']));
  });

  it('a failed download leaves no half-installed model', async () => {
    await expect(
      installVoiceModels(dir, 'base', {
        download: async (url, destination) => {
          if (url.includes('whisper')) throw new Error('rede caiu');
          fs.writeFileSync(destination, 'x');
        },
        extract: fakeExtract(['sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/tokens.txt']),
      }),
    ).rejects.toThrow('rede caiu');
    expect(fs.readdirSync(dir).filter((name) => name.includes('whisper') || name.startsWith('.tmp'))).toEqual([]);
  });
});

describe('downloadFile', () => {
  it('streams to disk and reports progress up to the total', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzdl-'));
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const fetchFn = async () => ({
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? '3' : null) },
      body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
    });
    const events = [];
    await downloadFile('https://x/y', path.join(dir, 'f'), (event) => events.push(event), fetchFn);
    expect([...fs.readFileSync(path.join(dir, 'f'))]).toEqual([1, 2, 3]);
    expect(events.at(-1)).toEqual({ received: 3, total: 3 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
