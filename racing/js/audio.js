// Procedural engine + UI sounds generated with the Web Audio API.
// The running engine models a 2006-era F1 V8:
//   * 8 detuned sawtooth oscillators = the 8 cylinders firing (thick, rough).
//   * fundamental maps to RPM: ~55Hz lumpy buzz at idle -> ~900-1000Hz scream at max.
//   * harmonic oscillators (2x/3x/4x) build with revs for the metallic growl.
//   * a waveshaper adds raw, aggressive distortion.
//   * a bandpass formant opens (and tightens) with RPM = the building wail.
// Low RPM = a lumpy aggressive idle; high RPM = an ear-piercing screaming wail.

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

    // Engine bus: [8 cylinders + harmonics] -> drive -> waveshaper -> bandpass -> engineGain -> master
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001; // silent until the engine runs

    // Bandpass formant that opens up (and tightens) with revs: a low raspy
    // growl at idle building into a bright screaming wail at the redline.
    this.bandpass = ctx.createBiquadFilter();
    this.bandpass.type = 'bandpass';
    this.bandpass.frequency.value = 220;
    this.bandpass.Q.value = 0.8;

    // Waveshaper for raw, aggressive distortion (the racing-engine edge)
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this._makeDistortionCurve(20);
    this.shaper.oversample = '4x';

    // Pre-distortion drive — pushed harder on throttle for extra bite
    this.driveGain = ctx.createGain();
    this.driveGain.gain.value = 0.85;

    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.bandpass);
    this.bandpass.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // --- 8 cylinder oscillators: detuned sawtooths => thick, rough V8 texture ---
    const cylBus = ctx.createGain();
    cylBus.gain.value = 0.28;
    cylBus.connect(this.driveGain);
    const detunes = [-17, -12, -7, -2, 3, 8, 13, 18]; // cents spread for firing roughness
    this.cylinders = detunes.map((cents) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = cents;
      o.frequency.value = 55;
      o.connect(cylBus);
      o.start();
      return o;
    });

    // --- Harmonic oscillators (2x/3x/4x): metallic growl that builds with revs ---
    const harmBus = ctx.createGain();
    harmBus.gain.value = 1.0;
    harmBus.connect(this.driveGain);
    this.harmonics = [
      { mult: 2, g0: 0.12, g1: 0.16 },
      { mult: 3, g0: 0.05, g1: 0.18 },
      { mult: 4, g0: 0.02, g1: 0.16 },
    ].map((d) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 110;
      const g = ctx.createGain();
      g.gain.value = d.g0;
      o.connect(g);
      g.connect(harmBus);
      o.start();
      return { o, g, mult: d.mult, g0: d.g0, g1: d.g1 };
    });

    // Shared noise buffer for the mechanical one-shots (crank/shift/fail)
    this.noiseBuf = this._makeNoise(ctx, 1.5);

    // Subtle intake hiss, added clean after the engine filter
    this.noise = ctx.createBufferSource();
    this.noise.buffer = this.noiseBuf;
    this.noise.loop = true;
    const nbp = ctx.createBiquadFilter();
    nbp.type = 'bandpass';
    nbp.frequency.value = 2200;
    nbp.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.012;
    this.noise.connect(nbp);
    nbp.connect(this.noiseGain);
    this.noiseGain.connect(this.engineGain);
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

  // Soft-clipping distortion curve for engine grit (higher amount = harsher).
  _makeDistortionCurve(amount) {
    const n = 1024;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
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

  // Per-frame: drive the V8 voice from RPM / throttle / speed.
  update(rpm, throttle, running, speed) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;

    if (!running) {
      this.engineGain.gain.setTargetAtTime(0.0001, t, 0.08);
      return;
    }

    // Fundamental (firing) frequency: ~55Hz lumpy buzz at idle, ~900Hz at the
    // redline, up to ~1000Hz on over-rev. Linear with RPM = real firing cadence.
    const rev  = Math.max(0, (rpm - 900) / (7200 - 900)); // 0 idle .. 1 redline (may exceed)
    const revC = Math.min(rev, 1);
    const base = 55 + Math.min(rev, 1.2) * 845;

    // 8 cylinders track the fundamental (their fixed detune keeps the spread)
    this.cylinders.forEach((o) => o.frequency.setTargetAtTime(base, t, 0.03));

    // Harmonics climb in pitch and grow in level with revs (metallic scream)
    this.harmonics.forEach(({ o, g, mult, g0, g1 }) => {
      o.frequency.setTargetAtTime(base * mult, t, 0.03);
      g.gain.setTargetAtTime(g0 + g1 * revC, t, 0.05);
    });

    // Bandpass opens and tightens with revs => the building scream
    const revShape = Math.pow(Math.min(rev, 1.15), 1.15);
    this.bandpass.frequency.setTargetAtTime(220 + revShape * 3600, t, 0.05);
    this.bandpass.Q.setTargetAtTime(0.8 + revC * 1.7, t, 0.06);

    // Throttle pushes the distortion harder for an aggressive on-power bite
    this.driveGain.gain.setTargetAtTime(throttle ? 1.3 : 0.85, t, 0.08);

    // Volume rises with RPM and throttle
    const vol = 0.13 + Math.min(rev, 1.1) * 0.5 + (throttle ? 0.12 : 0) + Math.min(Math.abs(speed) / 120, 1) * 0.05;
    this.engineGain.gain.setTargetAtTime(Math.min(vol, 0.92), t, 0.05);
  }
}

export const engineAudio = new EngineAudio();
