// Hands the microphone's frames (128 samples at the context's 16 kHz) to the page.
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
