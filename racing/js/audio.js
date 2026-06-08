// Engine + UI sounds via the Web Audio API.
// The running engine is a REAL recorded racing engine (assets/engine.mp3 —
// "Racing motorcycle engine" from Mixkit, free SFX license, no attribution
// required). It plays as a seamless loop whose playbackRate is driven by RPM,
// so it revs up and down like a real engine. The starter/shift/fail sounds are
// short synthesized mechanical effects.

const ENGINE_URL = new URL('../assets/engine.mp3', import.meta.url);

class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.engineReady = false; // sample decoded + looping
  }

  // Build the audio graph. Must run after a user gesture (autoplay policy).
  _init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = this.ctx = new Ctx({ latencyHint: 'interactive' });

    // iOS: route through the "playback" session so sound is heard even when
    // the phone's silent/ring switch is on.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

    // Master chain with a limiter
    this.master = ctx.createGain();
    this.master.gain.value = 0.95;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 6;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Running-engine path: sample loop -> tone lowpass -> engineGain -> master
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001; // silent until running
    this.engineLP = ctx.createBiquadFilter();
    this.engineLP.type = 'lowpass';
    this.engineLP.frequency.value = 2000;
    this.engineLP.Q.value = 0.7;
    this.engineLP.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Noise buffer for the synthesized one-shots
    this.noiseBuf = this._makeNoise(ctx, 1.5);

    this.ready = true;
    this._loadEngineSample();
  }

  async _loadEngineSample() {
    try {
      const resp = await fetch(ENGINE_URL);
      const data = await resp.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = 0.8;
      src.connect(this.engineLP);
      src.start(0);
      this.engineSource = src;
      this.engineReady = true;
    } catch (e) {
      // If the sample can't load, the engine simply stays silent.
      this.engineReady = false;
    }
  }

  _makeNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Resume/initialise on the first user gesture. Mobile browsers (esp. iOS)
  // need the context created AND unlocked inside a real touch handler.
  attachAutoResume() {
    const unlock = () => {
      this._init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (!this._unlocked) {
        try {
          const s = this.ctx.createBufferSource();
          s.buffer = this.ctx.createBuffer(1, 1, 22050);
          s.connect(this.ctx.destination);
          s.start(0);
          this._unlocked = true;
        } catch (e) {}
      }
    };
    ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown'].forEach((ev) => {
      window.addEventListener(ev, unlock, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    });
  }

  // Starter-motor crank: chugging low oscillator + whine, ~1.1s.
  crank() {
    this._init();
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, dur = 1.1;

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(55, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);

    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.16;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);

    o.connect(g);
    g.connect(this.master);
    o.start(t);
    lfo.start(t);
    g.gain.setTargetAtTime(0.0001, t + dur - 0.12, 0.05);
    o.stop(t + dur);
    lfo.stop(t + dur);

    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.05, t);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    n.start(t);
    ng.gain.setTargetAtTime(0.0001, t + dur - 0.2, 0.08);
    n.stop(t + dur);
  }

  // Mechanical gear-shift clunk.
  shift() {
    this._init();
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 320;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    n.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    n.start(t);
    n.stop(t + 0.12);
  }

  // Dead "click-click" when starting with ignition off.
  fail() {
    this._init();
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (let k = 0; k < 2; k++) {
      const tt = t + k * 0.085;
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1600;
      bp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.13, tt);
      g.gain.exponentialRampToValueAtTime(0.001, tt + 0.05);
      n.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      n.start(tt);
      n.stop(tt + 0.06);
    }
  }

  // Per-frame: drive the recorded engine loop from RPM / throttle / speed.
  update(rpm, throttle, running, speed) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;

    if (!running) {
      this.engineGain.gain.setTargetAtTime(0.0001, t, 0.1);
      return;
    }
    if (!this.engineReady) return; // sample still loading

    const rev = Math.max(0, (rpm - 900) / (7200 - 900)); // 0 idle .. 1 redline (may exceed)

    // Playback rate revs the loop: deeper/slower at idle, screaming at redline
    const rate = 0.72 + Math.min(rev, 1.25) * 1.25; // ~0.72 idle -> ~1.97 redline
    this.engineSource.playbackRate.setTargetAtTime(rate, t, 0.06);

    // Tone opens up with revs for extra brightness up top
    this.engineLP.frequency.setTargetAtTime(1400 + Math.min(rev, 1) * 6000, t, 0.06);

    // Volume rises with RPM and throttle
    const vol = 0.3 + Math.min(rev, 1.1) * 0.45 + (throttle ? 0.12 : 0) + Math.min(Math.abs(speed) / 120, 1) * 0.05;
    this.engineGain.gain.setTargetAtTime(Math.min(vol, 0.95), t, 0.05);
  }
}

export const engineAudio = new EngineAudio();
