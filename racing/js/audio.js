// Engine + UI sounds (Web Audio API) — deliberately SIMPLE.
//
// The engine is ONE real recorded engine loop (assets/engine.wav, a CC0 /
// public-domain racing-car engine from OpenGameArt). It loops continuously
// while the engine is running and is silenced when off. The only dynamic is a
// slight volume change with throttle: louder when accelerating, quieter when
// coasting. No pitch-shifting, no filtering, no layering.

const ENGINE_URL = new URL('../assets/engine.wav', import.meta.url);
const COAST_VOL = 0.40; // engine running, off the throttle
const ACCEL_VOL = 0.85; // engine running, accelerating

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
    const ctx = this.ctx = new Ctx();

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // The looping engine runs through its own gain (0 = silent/off)
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engineGain.connect(this.master);

    this.noiseBuf = this._makeNoise(ctx, 1.0);

    this.ready = true;
    this._loadEngine();
  }

  async _loadEngine() {
    try {
      const resp = await fetch(ENGINE_URL);
      const buf = await this.ctx.decodeAudioData(await resp.arrayBuffer());
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.engineGain);
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

  // Initialise/resume on the first user gesture (autoplay policy).
  attachAutoResume() {
    const unlock = () => {
      this._init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    };
    ['keydown', 'pointerdown', 'mousedown'].forEach((ev) =>
      window.addEventListener(ev, unlock, { passive: true })
    );
  }

  // --- Short mechanical one-shots (not the engine drone) ---
  crank() {
    this._init();
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, dur = 1.0;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 55;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.16;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    o.connect(g);
    g.connect(this.master);
    o.start(t); lfo.start(t);
    g.gain.setTargetAtTime(0.0001, t + dur - 0.12, 0.05);
    o.stop(t + dur); lfo.stop(t + dur);
  }

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
    n.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.12);
  }

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
      n.connect(bp); bp.connect(g); g.connect(this.master);
      n.start(tt); n.stop(tt + 0.06);
    }
  }

  // Per-frame: engine loop volume only. running -> loop audible; off -> silent.
  update(running, throttle) {
    if (!this.ready || !this.ctx || !this.engineReady) return;
    const t = this.ctx.currentTime;
    const target = running ? (throttle ? ACCEL_VOL : COAST_VOL) : 0.0001;
    this.engineGain.gain.setTargetAtTime(target, t, 0.15);
  }
}

export const engineAudio = new EngineAudio();
