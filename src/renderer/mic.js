// The hidden window that owns the microphone (#161). Chromium does the
// capture, echo cancellation, noise suppression and gain; the frames go to
// main in ~100 ms batches. Nothing is stored.
const BATCH = 1536; // 12 frames of 128 ≈ 96 ms at 16 kHz
let context = null;
let stream = null;

async function start() {
  if (context) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('mic-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(context, 'mic-tap');
    let batch = new Float32Array(BATCH);
    let filled = 0;
    tap.port.onmessage = ({ data }) => {
      for (let index = 0; index < data.length; index++) {
        batch[filled++] = data[index];
        if (filled === BATCH) {
          window.mic.chunk(batch);
          batch = new Float32Array(BATCH);
          filled = 0;
        }
      }
    };
    source.connect(tap);
    window.mic.status('ok');
  } catch (error) {
    window.mic.status(`erro: ${error?.message ?? error}`);
  }
}

function stop() {
  stream?.getTracks().forEach((track) => track.stop());
  context?.close();
  context = null;
  stream = null;
}

window.mic.onControl((command) => (command === 'start' ? start() : stop()));
