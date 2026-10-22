// Records system audio (Windows loopback) and an optional microphone,
// mixed together. Audio is captured as raw, uncompressed stereo samples,
// so the recording is identical to what was playing.
import workletUrl from './pcm-worklet.js?url';

// Chromium treats loopback audio like a call microphone by default
// (mono + echo cancellation + noise suppression + auto gain), which
// ruins music. Turn all of that off and ask for stereo.
const CLEAN_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
  channelCount: 2,
};

export async function startRecording({ micOn = false } = {}) {
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { ...CLEAN_AUDIO, suppressLocalAudioPlayback: false },
  });
  display.getVideoTracks().forEach((t) => t.stop()); // we only want the sound

  const systemTracks = display.getAudioTracks();
  if (!systemTracks.length) {
    throw new Error('Could not access system audio.');
  }
  // Belt and braces: some versions ignore constraints passed to getDisplayMedia.
  await systemTracks[0].applyConstraints(CLEAN_AUDIO).catch(() => {});

  const ctx = new AudioContext({ latencyHint: 'playback' });
  await ctx.audioWorklet.addModule(workletUrl);

  const mix = ctx.createGain();
  mix.channelCount = 2;
  mix.channelCountMode = 'explicit';

  const capture = new AudioWorkletNode(ctx, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  mix.connect(capture);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  mix.connect(analyser);

  const systemSource = ctx.createMediaStreamSource(new MediaStream(systemTracks));
  systemSource.connect(mix);

  const micGain = ctx.createGain();
  micGain.gain.value = 0;
  micGain.connect(mix);
  let micStream = null;

  async function setMicOn(on) {
    if (on && !micStream) {
      // Voice cleanup is useful for the mic (it only affects the mic, not system audio).
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      ctx.createMediaStreamSource(micStream).connect(micGain);
    }
    // Short ramp avoids clicks when toggling.
    micGain.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.015);
  }

  const left = [];
  const right = [];
  let frames = 0;
  capture.port.onmessage = (e) => {
    if (e.data === 'done') return;
    left.push(e.data[0]);
    right.push(e.data[1]);
    frames += e.data[0].length;
  };

  // If the mic fails to open, recording still continues with system audio only.
  let micError = null;
  if (micOn) {
    try {
      await setMicOn(true);
    } catch (err) {
      micError = err;
    }
  }

  const timeData = new Float32Array(analyser.fftSize);

  function cleanup() {
    systemTracks.forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  }

  return {
    micError,
    setMicOn,
    getLevel() {
      analyser.getFloatTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
      return Math.min(1, Math.sqrt(sum / timeData.length) * 4);
    },
    // Resolves with an AudioBuffer of everything recorded.
    stop() {
      return new Promise((resolve, reject) => {
        const prev = capture.port.onmessage;
        capture.port.onmessage = (e) => {
          if (e.data !== 'done') return prev(e);
          cleanup();
          if (!frames) return reject(new Error('Nothing was recorded.'));
          const buffer = new AudioBuffer({ length: frames, numberOfChannels: 2, sampleRate: ctx.sampleRate });
          const L = buffer.getChannelData(0);
          const R = buffer.getChannelData(1);
          let offset = 0;
          for (let i = 0; i < left.length; i++) {
            L.set(left[i], offset);
            R.set(right[i], offset);
            offset += left[i].length;
          }
          resolve(buffer);
        };
        capture.port.postMessage('flush');
      });
    },
  };
}
