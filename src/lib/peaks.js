// Returns `count` normalized-ready peak values (0..1) for the time range [from, to] seconds.
export function computePeaks(buffer, from, to, count) {
  const out = new Float32Array(Math.max(0, count));
  if (count <= 0) return out;

  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));

  const rate = buffer.sampleRate;
  const first = from * rate;
  const perBar = ((to - from) * rate) / count;

  for (let i = 0; i < count; i++) {
    const a = Math.floor(first + i * perBar);
    const b = Math.max(a + 1, Math.floor(first + (i + 1) * perBar));
    // For very long blocks, sample ~600 points; enough for a smooth look.
    const step = Math.max(1, Math.floor((b - a) / 600));
    let peak = 0;
    for (let j = a; j < b; j += step) {
      for (const data of channels) {
        const v = Math.abs(data[j] || 0);
        if (v > peak) peak = v;
      }
    }
    out[i] = peak;
  }
  return out;
}

// Loudest sample in the whole buffer (used so every zoom level uses the same scale).
export function maxPeak(buffer) {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.abs(d[i]);
      if (v > max) max = v;
    }
  }
  return max || 1;
}
