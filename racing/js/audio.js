// Procedural engine + UI sounds generated with the Web Audio API.
// The running-engine tone is voiced as a high-revving V8 (F1-style scream):
// a rich sawtooth harmonic stack driven up in pitch by RPM, with a resonant
// "wail" formant that sweeps dramatically toward the redline.

class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
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

    // Master chain with a limiter so the aggressive tone never clips harshly
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Tone bus: oscillators -> highpass -> scream(peaking) -> engineGain -> master
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001; // silent until the engine runs

    this.scream = ctx.createBiquadFilter();
    this.scream.type = 'peaking';
    this.scream.frequency.value = 800;
    this.scream.Q.value = 9;
    this.scream.gain.value = 15;        // strong resonant wail

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 200;      // keep it bright, not rumbly
    this.hp.Q.value = 0.7;

    this.hp.connect(this.scream);
    this.scream.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Harmonic stack — high partials grow with revs for the sharp scream.
    // gain = g0 + g1 * revShape  (set each frame in update()).
    this.oscDefs = [
      { type: 'sawtooth', mult: 1.0, g0: 0.32, g1: 0.24 }, // fundamental
      { type: 'sawtooth', mult: 2.0, g0: 0.12, g1: 0.26 }, // 2nd
      { type: 'sawtooth', mult: 3.0, g0: 0.04, g1: 0.28 }, // 3rd — the wail
      { type: 'sawtooth', mult: 4.0, g0: 0.02, g1: 0.20 }, // sharpness up top
      { type: 'square',   mult: 0.5, g0: 0.16, g1: 0.02 }, // sub body (fades up)
    ];
    this.oscs = this.oscDefs.map((d) => {
      const o = ctx.createOscillator();
      o.type = d.type;
      o.frequency.value = 150;
      const g = ctx.createGain();
      g.gain.value = d.g0;
      o.connect(g);
      g.connect(this.hp);
      o.start();
      return { o, g, mult: d.mult, g0: d.g0, g1: d.g1 };
    });

    // Detuned twin of the fundamental — shimmer/beating for a metallic edge
    this.twin = ctx.createOscillator();
    this.twin.type = 'sawtooth';
    this.twin.detune.value = 11; // cents
    this.twin.frequency.value = 150;
    const twinG = ctx.createGain();
    twinG.gain.value = 0.16;
    this.twin.connect(twinG);
    twinG.connect(this.hp);
    this.twin.start();

    // Shared noise buffer for texture / mechanical sounds
    this.noiseBuf = this._makeNoise(ctx, 1.5);

    // Light induction hiss
    this.noise = ctx.createBufferSource();
    this.noise.buffer = this.noiseBuf;
    this.noise.loop = true;
    const nbp = ctx.createBiquadFilter();
    nbp.type = 'bandpass';
    nbp.frequency.value = 2400;
    nbp.Q.value = 0.8;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.02;
    this.noise.connect(nbp);
    nbp.connect(this.noiseGain);
    this.noiseGain.connect(this.hp);
    this.noise.start();

    this.ready = true;
  }

  _makeNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Resume/initialise on the first user gesture. Mobile browsers (esp. iOS)
  // need the context created AND unlocked with a silent buffer inside a real
  // touch handler, so we listen broadly and keep retrying until it's running.
  attachAutoResume() {
    const unlock = () => {
      this._init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (!this._unlocked) {
        try {
          const src = this.ctx.createBufferSource();
          src.buffer = this.ctx.createBuffer(1, 1, 22050);
          src.connect(this.ctx.destination);
          src.start(0);
          this._unlocked = true;
        } catch (e) {}
      }
    };
    ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown'].forEach((ev) => {
      window.addEventListener(ev, unlock, { passive: true });
    });
    // Resume again if the tab/app returns to the foreground
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

  // Per-frame: shape the V8 scream from RPM / throttle / speed.
  update(rpm, throttle, running, speed) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;

    if (!running) {
      this.engineGain.gain.setTargetAtTime(0.0001, t, 0.08);
      return;
    }

    const revFrac = Math.min(rpm / 7200, 1);
    const revShape = Math.pow(revFrac, 1.3); // bias drama toward high revs

    // V8 firing frequency (rpm/15), pitched up for the F1 scream
    const firing = Math.max(40, rpm / 15);
    const base = firing * 2.5;
    this.oscs.forEach(({ o, g, mult, g0, g1 }) => {
      o.frequency.setTargetAtTime(base * mult, t, 0.02);
      g.gain.setTargetAtTime(g0 + g1 * revShape, t, 0.03);
    });
    this.twin.frequency.setTargetAtTime(base, t, 0.02);

    // Resonant wail sweeps up dramatically with revs
    this.scream.frequency.setTargetAtTime(500 + revShape * 4300, t, 0.04);
    this.scream.Q.setTargetAtTime(8 + revShape * 9, t, 0.05);

    const vol = 0.1 + revShape * 0.6 + (throttle ? 0.1 : 0) + Math.min(Math.abs(speed) / 100, 1) * 0.05;
    this.engineGain.gain.setTargetAtTime(vol, t, 0.04);
  }
}

export const engineAudio = new EngineAudio();
