// The hidden window that owns the microphone (#161). Chromium does the
// capture, echo cancellation, noise suppression and gain; the frames go to
// main in ~100 ms batches. Nothing is stored.
import { listMics, listOutputs, pickMic } from './mic-choice.js';

const BATCH = 1536; // 12 frames of 128 ≈ 96 ms at 16 kHz
let context = null;
let stream = null;
let wanted = null; // { id, label } the user pinned, or null for the system default
let starting = null;
let on = false; // main asked for the mic (a failed open is retried on the next device change)

async function start() {
  if (context || starting) return starting;
  starting = open().finally(() => {
    starting = null;
  });
  return starting;
}

async function open() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const deviceId = pickMic(devices, wanted);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
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
    // Labels only come with the permission: the list is sent once it is open.
    const found = await navigator.mediaDevices.enumerateDevices();
    window.mic.devices(listMics(found), listOutputs(found));
    window.mic.status(`ok (${stream.getAudioTracks()[0]?.label || 'padrão'})`);
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

// A mic plugged in or out: the default may have moved, the pinned one may be
// back or gone. Reopen on the right one (debounced: a headset fires several).
// Chromium on Linux only hears udev, so a virtual or Bluetooth source never
// fires devicechange: the list is also compared every few seconds.
let changeTimer = null;
let knownMics = null;
function deviceChanged() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    if (!on) return;
    stop();
    await start();
  }, 500);
}
navigator.mediaDevices.addEventListener('devicechange', deviceChanged);
setInterval(async () => {
  if (!on || !context) return;
  const found = await navigator.mediaDevices.enumerateDevices();
  const mics = JSON.stringify([listMics(found), listOutputs(found)]);
  if (knownMics !== null && mics !== knownMics) deviceChanged();
  knownMics = mics;
}, 5000);

window.mic.onControl((control) => {
  const command = typeof control === 'string' ? control : control?.command;
  if (control && typeof control === 'object' && 'mic' in control) wanted = control.mic ?? null;
  on = command !== 'stop';
  if (!on) return stop();
  if (command === 'restart') stop();
  return start();
});
