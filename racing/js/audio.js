// Procedural engine + UI sounds generated with the Web Audio API.
// The running engine is voiced as a V8: a sub-bass rumble for the engine body,
// a sawtooth firing fundamental at the true V8 firing frequency (rpm/15), and
// upper harmonics that grow with revs. Run through a waveshaper for raw grit and
// a lowpass that opens with RPM — so it's a deep growl at idle that builds into
// an aggressive, throaty wail at the redline (not a thin high-pitched whine).

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

    // Tone bus: oscillators -> oscMix -> waveshaper(distortion) -> lowpass -> engineGain -> master
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001; // silent until the engine runs

    // Lowpass opens with RPM: muffled growl at idle, bright wail at the redline
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 400;
    this.lowpass.Q.value = 1.6;

    // Waveshaper adds raw, raspy grit (the racing-engine edge)
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this._makeDistortionCurve(10);
    this.shaper.oversample = '2x';

    this.oscMix = ctx.createGain();
    this.oscMix.gain.value = 0.5;        // drive level into the distortion

    this.oscMix.connect(this.shaper);
    this.shaper.connect(this.lowpass);
    this.lowpass.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Layered oscillators at multiples of the firing frequency.
    // gain = g0 + g1*revShape: low layers dominate the idle growl, upper
    // harmonics grow with revs for the high-RPM scream.
    this.oscDefs = [
      { type: 'sine',     mult: 0.5, g0: 0.55, g1: -0.20 }, // sub-bass rumble (engine body)
      { type: 'sawtooth', mult: 1.0, g0: 0.45, g1: 0.05  }, // firing fundamental
      { type: 'sawtooth', mult: 2.0, g0: 0.18, g1: 0.22  }, // growl harmonic
      { type: 'sawtooth', mult: 3.0, g0: 0.06, g1: 0.26  }, // scream harmonic
      { type: 'sawtooth', mult: 4.0, g0: 0.02, g1: 0.18  }, // top-end bite
    ];
    this.oscs = this.oscDefs.map((d) => {
      const o = ctx.createOscillator();
      o.type = d.type;
      o.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = d.g0;
      o.connect(g);
      g.connect(this.oscMix);
      o.start();
      return { o, g, mult: d.mult, g0: d.g0, g1: d.g1 };
    });

    // Detuned twin of the fundamental — thickens the tone with a beating texture
    this.twin = ctx.createOscillator();
    this.twin.type = 'sawtooth';
    this.twin.detune.value = 14; // cents
    this.twin.frequency.value = 60;
    const twinG = ctx.createGain();
    twinG.gain.value = 0.18;
    this.twin.connect(twinG);
    twinG.connect(this.oscMix);
    this.twin.start();

    // Shared noise buffer for texture / mechanical sounds
    this.noiseBuf = this._makeNoise(ctx, 1.5);

    // Subtle intake/induction hiss (added clean, after the distortion)
    this.noise = ctx.createBufferSource();
    this.noise.buffer = this.noiseBuf;
    this.noise.loop = true;
    const nbp = ctx.createBiquadFilter();
    nbp.type = 'bandpass';
    nbp.frequency.value = 1800;
    nbp.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.015;
    this.noise.connect(nbp);
    nbp.connect(this.noiseGain);
    this.noiseGain.connect(this.lowpass);
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

  // Per-frame: shape the V8 tone from RPM / throttle / speed.
  update(rpm, throttle, running, speed) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;

    if (!running) {
      this.engineGain.gain.setTargetAtTime(0.0001, t, 0.08);
      return;
    }

    const revFrac = Math.min(rpm / 7200, 1);
    const revShape = Math.pow(revFrac, 1.2);

    // True V8 firing frequency — deep at idle (~60Hz), rises linearly with revs.
    // No pitch inflation, so low RPM stays a throaty growl.
    const firing = Math.max(28, rpm / 15);
    this.oscs.forEach(({ o, g, mult, g0, g1 }) => {
      o.frequency.setTargetAtTime(firing * mult, t, 0.025);
      g.gain.setTargetAtTime(Math.max(0, g0 + g1 * revShape), t, 0.04);
    });
    this.twin.frequency.setTargetAtTime(firing, t, 0.025);

    // Brightness opens up with revs: muffled growl -> bright, aggressive wail
    this.lowpass.frequency.setTargetAtTime(350 + revShape * 3200, t, 0.05);

    const vol = 0.14 + revShape * 0.5 + (throttle ? 0.08 : 0) + Math.min(Math.abs(speed) / 120, 1) * 0.05;
    this.engineGain.gain.setTargetAtTime(vol, t, 0.05);
  }
}

export const engineAudio = new EngineAudio();
