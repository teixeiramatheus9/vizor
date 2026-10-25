import { EventEmitter } from 'node:events';
import path from 'node:path';

// The speech engine (#161): keyword spotting ("Vizor") always, voice activity
// while listening, and Whisper on demand. sherpa-onnx-node is injected, so
// this is tested with a fake. Inside Electron, V8's memory cage refuses
// external buffers: every buffer the addon hands back is asked for as a copy.
const SAMPLE_RATE = 16000;
const WINDOW = 512; // silero VAD's window; the spotter takes the same chunks
const TARGET_PEAK = 0.5;
// "Vizor, o que temos pra hoje" in one breath: the spotter fires ~0.6 s after
// the word, so the VAD starts from this much audio before the wake.
const PREROLL_WINDOWS = Math.ceil((1.5 * SAMPLE_RATE) / WINDOW);
const MAX_GAIN = 8;

// The laptop's DMIC peaks low (spike: -28 dB on speech). A slow automatic
// gain: follows the recent peak, lifts up to MAX_GAIN, never clips.
export function normalizeChunk(samples, state) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  state.peak = Math.max(peak, (state.peak ?? 0) * 0.995);
  if (state.peak < 1e-4) return samples;
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / state.peak);
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) out[index] = Math.max(-1, Math.min(1, samples[index] * gain));
  return out;
}

const KWS_FILES = {
  encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
};

// paths: { kws: { dir, keywordsFile }, vad: <silero .onnx>, asr: { dir, prefix: 'base'|'small' } }
export function createVoiceEngine({ sherpa, paths, threads = 4, keywordsThreshold = 0.25, normalize = true }) {
  const engine = new EventEmitter();
  const feat = { sampleRate: SAMPLE_RATE, featureDim: 80 };
  const spotter = new sherpa.KeywordSpotter({
    featConfig: feat,
    modelConfig: {
      transducer: Object.fromEntries(Object.entries(KWS_FILES).map(([key, file]) => [key, path.join(paths.kws.dir, file)])),
      tokens: path.join(paths.kws.dir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    keywordsFile: paths.kws.keywordsFile,
    keywordsThreshold,
    keywordsScore: 1.0,
  });
  const spotStream = spotter.createStream();
  const vad = new sherpa.Vad(
    {
      sileroVad: { model: paths.vad, threshold: 0.5, minSpeechDuration: 0.2, minSilenceDuration: 0.3, windowSize: WINDOW },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: false,
    },
    60,
  );
  let recognizer = null; // loaded on first use: ~1 s, and only if voice is used
  const asrPrefix = path.join(paths.asr.dir, paths.asr.prefix);

  let listening = false;
  let speaking = false;
  let carry = new Float32Array(0);
  let preroll = [];
  const gainState = {};

  function spot(window) {
    spotStream.acceptWaveform({ samples: window, sampleRate: SAMPLE_RATE });
    while (spotter.isReady(spotStream)) {
      spotter.decode(spotStream);
      if (spotter.getResult(spotStream).keyword) {
        spotter.reset(spotStream);
        engine.emit('wake');
        if (!listening) {
          listening = true;
          for (const earlier of preroll) track(earlier);
        }
      }
    }
  }

  function track(window) {
    vad.acceptWaveform(window);
    const detected = vad.isDetected();
    if (detected && !speaking) engine.emit('speech-start');
    speaking = detected;
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      vad.pop();
      engine.emit('speech-end', { samples: Float32Array.from(segment.samples) });
    }
  }

  engine.feed = (chunk) => {
    const samples = normalize ? normalizeChunk(chunk, gainState) : chunk;
    const joined = new Float32Array(carry.length + samples.length);
    joined.set(carry);
    joined.set(samples, carry.length);
    let offset = 0;
    for (; offset + WINDOW <= joined.length; offset += WINDOW) {
      const window = joined.slice(offset, offset + WINDOW);
      spot(window);
      if (listening) track(window);
      preroll.push(window);
      if (preroll.length > PREROLL_WINDOWS) preroll.shift();
    }
    carry = joined.slice(offset);
  };

  // While not listening only the spotter runs (the idle cost).
  engine.listen = (on) => {
    listening = Boolean(on);
    if (!listening) {
      vad.reset?.();
      speaking = false;
    }
  };

  engine.transcribe = (samples) => {
    recognizer ??= new sherpa.OfflineRecognizer({
      featConfig: feat,
      modelConfig: {
        whisper: {
          encoder: `${asrPrefix}-encoder.int8.onnx`,
          decoder: `${asrPrefix}-decoder.int8.onnx`,
          language: 'pt',
          task: 'transcribe',
          tailPaddings: -1,
        },
        tokens: `${asrPrefix}-tokens.txt`,
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
    });
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    recognizer.decode(stream);
    return String(recognizer.getResult(stream).text ?? '').trim();
  };

  return engine;
}
