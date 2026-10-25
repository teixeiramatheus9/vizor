// The speech engine's thread (#161): Whisper's 0.5–0.9 s of CPU per part
// must never run on Electron's main thread, where the app and the
// workspace terminals live.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createVoiceEngine } from './engine.js';

const post = (message) => parentPort.postMessage(message);

try {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  const engine = createVoiceEngine({ sherpa, paths: workerData.paths, threads: workerData.threads ?? 4 });
  engine.on('wake', () => post({ type: 'wake' }));
  engine.on('speech-start', () => post({ type: 'speech-start' }));
  engine.on('speech-end', ({ samples }) => post({ type: 'speech-end', samples }));
  parentPort.on('message', (message) => {
    try {
      if (message.type === 'chunk') engine.feed(Float32Array.from(message.samples));
      else if (message.type === 'listen') engine.listen(message.on);
      else if (message.type === 'transcribe') post({ type: 'transcript', id: message.id, text: engine.transcribe(message.samples) });
      else if (message.type === 'close') parentPort.close();
    } catch (error) {
      post({ type: 'error', error: String(error?.message ?? error) });
    }
  });
  post({ type: 'ready' });
} catch (error) {
  post({ type: 'error', error: String(error?.message ?? error) });
}
