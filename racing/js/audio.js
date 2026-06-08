// Engine + UI sounds via the Web Audio API.
// The running engine is a REAL recorded racing-car engine loop
// (assets/engine.wav — CC0 / public domain, from OpenGameArt). It plays as a
// seamless continuous loop; its playbackRate is tied directly to RPM so it revs
// up and down with the car (subtle, realistic range — no synthesis). At the rev
// limiter a fast gain stutter mimics an F1 limiter bounce. The starter/shift/
// fail effects are short synthesized mechanical sounds.

const ENGINE_URL = new URL('../assets/engine.wav', import.meta.url);

class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.engineReady = false;
  }

  _init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = this.ctx = new Ctx({ latencyHint: 'interactive' });

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

    // Engine path: sample -> tone lowpass -> limiterGain -> engineGain -> master
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001; // silent until running

    this.limiterGain = ctx.createGain();
    this.limiterGain.gain.value = 1.0;

    this.engineLP = ctx.createBiquadFilter();
    this.engineLP.type = 'lowpass';
    this.engineLP.frequency.value = 2000;
    this.engineLP.Q.value = 0.7;

    this.engineLP.connect(this.limiterGain);
    this.limiterGain.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Rev-limiter bounce: a fast square LFO stutters the engine gain when the
    // limiter is active (depth ramps up only at the limiter).
    this.limiterLFO = ctx.createOscillator();
    this.limiterLFO.type = 'square';
    this.limiterLFO.frequency.value = 24;
    this.limiterDepth = ctx.createGain();
    this.limiterDepth.gain.value = 0;
    this.limiterLFO.connect(this.limiterDepth);
    this.limiterDepth.connect(this.limiterGain.gain);
    this.limiterLFO.start();

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
      src.playbackRate.value = 1.0;
      src.connect(this.engineLP);
      src.start(0);
      this.engineSource = src;
      this.engineReady = true;
    } catch (e) {
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

  // Starter-motor crank.
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
  update(rpm, throttle, running, speed, atLimiter) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;

    if (!running) {
      this.engineGain.gain.setTargetAtTime(0.0001, t, 0.1);
      this.limiterDepth.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    if (!this.engineReady) return;

    const rev = Math.max(0, (rpm - 900) / (7200 - 900)); // 0 idle .. 1 redline (may exceed)

    // Subtle, realistic playback-rate sweep tied DIRECTLY to RPM
    const rate = 0.9 + Math.min(rev, 1.2) * 0.6; // ~0.9 idle -> ~1.5 redline
    this.engineSource.playbackRate.setTargetAtTime(rate, t, 0.05);

    this.engineLP.frequency.setTargetAtTime(1500 + Math.min(rev, 1) * 5500, t, 0.06);

    const vol = 0.3 + Math.min(rev, 1.1) * 0.45 + (throttle ? 0.1 : 0) + Math.min(Math.abs(speed) / 120, 1) * 0.05;
    this.engineGain.gain.setTargetAtTime(Math.min(vol, 0.95), t, 0.05);

    // Rev-limiter bounce: engage the stutter only while bouncing off the limiter
    this.limiterDepth.gain.setTargetAtTime(atLimiter ? 0.45 : 0, t, atLimiter ? 0.005 : 0.04);
  }
}

export const engineAudio = new EngineAudio();
