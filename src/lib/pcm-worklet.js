// Captures raw stereo audio from the graph without any compression.
// Sends ~85 ms blocks to the main thread to keep message traffic low.
const BLOCK = 4096;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(BLOCK);
    this.right = new Float32Array(BLOCK);
    this.fill = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.send();
        this.port.postMessage('done');
      }
    };
  }

  send() {
    if (!this.fill) return;
    const l = this.left.slice(0, this.fill);
    const r = this.right.slice(0, this.fill);
    this.port.postMessage([l, r], [l.buffer, r.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const l = input[0];
      const r = input[1] || input[0];
      let i = 0;
      while (i < l.length) {
        const n = Math.min(l.length - i, BLOCK - this.fill);
        this.left.set(l.subarray(i, i + n), this.fill);
        this.right.set(r.subarray(i, i + n), this.fill);
        this.fill += n;
        i += n;
        if (this.fill === BLOCK) this.send();
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
