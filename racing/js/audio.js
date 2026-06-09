// Procedural engine + UI sounds generated with the Web Audio API.
// The running engine models a Mercedes M275-style V12 biturbo: deep, smooth and
// authoritative — a low grunt, not a high scream.
//   * 12 tightly-detuned sawtooth oscillators = a smooth, rich V12 stack.
//   * a clean sub-bass sine for the deep, grunty bottom end.
//   * fundamental tied DIRECTLY to RPM but kept in a LOW range (~36Hz idle ->
//     ~356Hz redline) so it stays deep and grunty as it revs.
//   * low-emphasis harmonics + only light distortion = refined, not aggressive.
//   * a warm lowpass that opens gently with revs (no screaming formant).
//   * a subtle turbo spool/whoosh that swells under hard throttle.

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

    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

    // Master chain with a limiter
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

    // Engine bus: [12 cylinders + harmonics] -> drive -> light waveshaper -> warm
    // lowpass -> engineGain -> master. Sub-bass added clean (no distortion).
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001; // silent until the engine runs

    // Warm lowpass that opens gently with revs (smooth, never screamy)
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 350;
    this.tone.Q.value = 0.6;

    // Only light distortion — refined V12, not an aggressive racer
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this._makeDistortionCurve(6);
    this.shaper.oversample = '4x';

    this.driveGain = ctx.createGain();
    this.driveGain.gain.value = 0.7;

    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.tone);
    this.tone.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // --- 12 cylinder oscillators: tightly detuned => smooth, rich V12 stack ---
    const cylBus = ctx.createGain();
    cylBus.gain.value = 0.2;
    cylBus.connect(this.driveGain);
    const detunes = [-9, -7, -5, -3, -1.5, -0.5, 0.5, 1.5, 3, 5, 7, 9];
    this.cylinders = detunes.map((cents) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = cents;
      o.frequency.value = 40;
      o.connect(cylBus);
      o.start();
      return o;
    });

    // --- Harmonics: strong low (2x), modest upper (smooth, not metallic) ---
    const harmBus = ctx.createGain();
    harmBus.gain.value = 1.0;
    harmBus.connect(this.driveGain);
    this.harmonics = [
      { mult: 2, g0: 0.18, g1: 0.06 },
      { mult: 3, g0: 0.07, g1: 0.05 },
      { mult: 4, g0: 0.025, g1: 0.03 },
    ].map((d) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 80;
      const g = ctx.createGain();
      g.gain.value = d.g0;
      o.connect(g);
      g.connect(harmBus);
      o.start();
      return { o, g, mult: d.mult, g0: d.g0, g1: d.g1 };
    });

    // --- Clean sub-bass sine for the deep, authoritative grunt ---
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 28;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.0001;
    this.sub.connect(this.subGain);
    this.subGain.connect(this.engineGain);
    this.sub.start();

    // Shared noise buffer (one-shots + turbo)
    this.noiseBuf = this._makeNoise(ctx, 1.5);

    // --- Turbo spool / induction whoosh: resonant noise that swells under
    //     hard throttle and rises in pitch with revs ---
    this.turbo = ctx.createBufferSource();
    this.turbo.buffer = this.noiseBuf;
    this.turbo.loop = true;
    this.turboBP = ctx.createBiquadFilter();
    this.turboBP.type = 'bandpass';
    this.turboBP.frequency.value = 1400;
    this.turboBP.Q.value = 4;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0.0001;
    this.turbo.connect(this.turboBP);
    this.turboBP.connect(this.turboGain);
    this.turboGain.connect(this.master);
    this.turbo.start();

    this.ready = true;
  }

  _makeNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

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

  // Resume/initialise on the first user gesture.
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
    ['pointerdown', 'mousedown', 'keydown'].forEach((ev) => {
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

  // Per-frame: drive the V12 voice from RPM / throttle / speed.
  update(rpm, throttle, running, speed) {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;

    if (!running) {
      this.engineGain.gain.setTargetAtTime(0.0001, t, 0.08);
      this.subGain.gain.setTargetAtTime(0.0001, t, 0.08);
      this.turboGain.gain.setTargetAtTime(0.0001, t, 0.15);
      return;
    }

    // ---- PITCH: tied DIRECTLY to RPM, kept LOW for a deep grunt ----
    const rev  = Math.max(0, (rpm - 900) / (7200 - 900)); // 0 idle .. 1 redline (may exceed)
    const revC = Math.min(rev, 1);
    const base = 36 + Math.min(rev, 1.3) * 320; // ~36Hz idle -> ~356Hz redline

    // 12 cylinders + harmonics track the fundamental
    this.cylinders.forEach((o) => o.frequency.setTargetAtTime(base, t, 0.025));
    this.harmonics.forEach(({ o, g, mult, g0, g1 }) => {
      o.frequency.setTargetAtTime(base * mult, t, 0.025);
      g.gain.setTargetAtTime(g0 + g1 * revC, t, 0.05);
    });

    // Clean sub-bass for the deep V12 bottom end
    this.sub.frequency.setTargetAtTime(Math.max(28, base * 0.5), t, 0.04);
    this.subGain.gain.setTargetAtTime(0.35, t, 0.06);

    // Warm tone opens gently with revs (smooth, refined — not screamy)
    this.tone.frequency.setTargetAtTime(320 + revC * 1650, t, 0.05);

    // Light on-power bite (kept subtle for a refined V12)
    this.driveGain.gain.setTargetAtTime(throttle ? 0.85 : 0.7, t, 0.1);

    // Turbo spool: faint induction hiss always, swelling to a whoosh under hard
    // throttle and rising in pitch with revs.
    const turboTarget = 0.008 + (throttle ? revC * 0.06 : 0);
    this.turboGain.gain.setTargetAtTime(turboTarget, t, 0.18);
    this.turboBP.frequency.setTargetAtTime(1100 + revC * 2600, t, 0.2);

    // Volume rises with RPM and throttle
    const vol = 0.16 + Math.min(rev, 1.1) * 0.5 + (throttle ? 0.1 : 0) + Math.min(Math.abs(speed) / 120, 1) * 0.05;
    this.engineGain.gain.setTargetAtTime(Math.min(vol, 0.95), t, 0.05);
  }
}

export const engineAudio = new EngineAudio();
