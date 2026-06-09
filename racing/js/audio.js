// Procedural engine + UI sounds (Web Audio API).
// Models a Mercedes M275-style V12 biturbo: deep, heavy, grunty and clearly
// audible even at idle.
//
// Grunt design (so it is actually HEARABLE, not just felt):
//   * V12 firing frequency = RPM/10 -> ~60Hz at 600rpm idle, ~650Hz at 6500rpm.
//   * 12 tightly-detuned sawtooths at the firing frequency: their harmonics
//     (120/180/240Hz at idle) sit right in the audible band = the grunt.
//   * a STRONG 2nd harmonic for extra low-mid body, plus a deep sub sine
//     (~30Hz) for the felt rumble on good speakers/headphones.
//   * a warm lowpass keeps it deep and heavy (never a thin/bright whine).
//   * idle is mixed LOUD so the grunt is obviously present.
//   * as RPM rises: pitch climbs, volume grows, filter opens, turbo swells.

class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
  }

  _init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = this.ctx = new Ctx({ latencyHint: 'interactive' });

    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

    // Master + limiter
    this.master = ctx.createGain();
    this.master.gain.value = 0.95;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -4;
    comp.knee.value = 8;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.15;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Engine bus: [12 cylinders + harmonics] -> drive -> warm lowpass ->
    // engineGain -> master. (No waveshaper — a V12 is smooth, and it was
    // attenuating the audible grunt harmonics.) Sub-bass added clean.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001; // silent until running

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 600;
    this.tone.Q.value = 0.7;

    this.driveGain = ctx.createGain();
    this.driveGain.gain.value = 1.0;

    this.driveGain.connect(this.tone);
    this.tone.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // --- 12 cylinders: widely detuned sawtooths => thick, grumbly stack ---
    const cylBus = ctx.createGain();
    cylBus.gain.value = 0.22;
    cylBus.connect(this.driveGain);
    const detunes = [-21, -16, -12, -8, -4, -1.5, 1.5, 4, 8, 12, 16, 21];
    this.cylinders = detunes.map((cents) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = cents;
      o.frequency.value = 60;
      o.connect(cylBus);
      o.start();
      return o;
    });

    // --- Harmonics: STRONG 2nd for audible grunt body; lighter above ---
    const harmBus = ctx.createGain();
    harmBus.gain.value = 1.0;
    harmBus.connect(this.driveGain);
    this.harmonics = [
      { mult: 2, g0: 0.50, g1: 0.04 }, // strong body for a thick grunt at all revs
      { mult: 3, g0: 0.30, g1: 0.02 },
      { mult: 4, g0: 0.12, g1: 0.00 },
    ].map((d) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 120;
      const g = ctx.createGain();
      g.gain.value = d.g0;
      o.connect(g);
      g.connect(harmBus);
      o.start();
      return { o, g, mult: d.mult, g0: d.g0, g1: d.g1 };
    });

    // --- Deep sub sine for the heavy rumble (clean, no distortion) ---
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 30;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.0001;
    this.sub.connect(this.subGain);
    this.subGain.connect(this.engineGain);
    this.sub.start();

    // --- Sub-octave growl: detuned saws an octave below the firing frequency,
    //     for a thick, fat low-mid body that reads as grumbly at all revs. ---
    const growlBus = ctx.createGain();
    growlBus.gain.value = 0.22;
    growlBus.connect(this.driveGain);
    this.growl = [-14, 0, 14].map((cents) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = cents;
      o.frequency.value = 45;
      o.connect(growlBus);
      o.start();
      return o;
    });

    this.noiseBuf = this._makeNoise(ctx, 1.5);

    // --- MAIN engine note: a high-pitched tone (filtered noise) whose pitch
    //     tracks RPM. Q kept moderate so it's a tone, not a hollow "tube"
    //     whistle, plus a warming lowpass to roll off the airy top. ---
    this.turbo = ctx.createBufferSource();
    this.turbo.buffer = this.noiseBuf;
    this.turbo.loop = true;
    this.turboBP = ctx.createBiquadFilter();
    this.turboBP.type = 'bandpass';
    this.turboBP.frequency.value = 800;
    this.turboBP.Q.value = 5;            // lower resonance -> less hollow/pressurised
    this.turboLP = ctx.createBiquadFilter();
    this.turboLP.type = 'lowpass';
    this.turboLP.frequency.value = 1200; // warms it: rolls off the airy hiss above the note
    this.turboLP.Q.value = 0.7;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0.0001;
    this.turbo.connect(this.turboBP);
    this.turboBP.connect(this.turboLP);
    this.turboLP.connect(this.turboGain);
    this.turboGain.connect(this.master);
    this.turbo.start();

    // --- Grumble: a low-rate amplitude throb on the engine bus for a rough,
    //     grumbly character (rate speeds up a little with revs in update()). ---
    this.grumbleLFO = ctx.createOscillator();
    this.grumbleLFO.type = 'sine';
    this.grumbleLFO.frequency.value = 8;
    this.grumbleDepth = ctx.createGain();
    this.grumbleDepth.gain.value = 0.28;
    this.grumbleLFO.connect(this.grumbleDepth);
    this.grumbleDepth.connect(this.engineGain.gain);
    this.grumbleLFO.start();

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

  // Starter-motor crank.
  crank() {
    this._init();
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, dur = 1.1;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(50, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 10;
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
    bp.frequency.value = 1300;
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

    const rev  = Math.max(0, (rpm - 900) / (7200 - 900)); // 0 idle .. 1 redline
    const revC = Math.min(rev, 1);

    // Firing fundamental kept in the audible-deep band (~90Hz idle -> ~650Hz
    // redline) so the grunt is heard on laptop speakers, not just felt.
    const firing = 90 + Math.min(rev, 1.2) * 560;

    this.cylinders.forEach((o) => o.frequency.setTargetAtTime(firing, t, 0.03));
    this.harmonics.forEach(({ o, g, mult, g0, g1 }) => {
      o.frequency.setTargetAtTime(firing * mult, t, 0.03);
      g.gain.setTargetAtTime(g0 + g1 * revC, t, 0.05);
    });
    // Sub-octave growl tracks half the firing frequency for thick low body
    this.growl.forEach((o) => o.frequency.setTargetAtTime(firing * 0.5, t, 0.03));

    // Deep sub rumble — stronger now for a heavier, grumbly low end.
    this.sub.frequency.setTargetAtTime(Math.max(30, firing * 0.5), t, 0.04);
    this.subGain.gain.setTargetAtTime(0.4, t, 0.06);

    // Warm (low) lowpass for a grumbly, un-bright character.
    this.tone.frequency.setTargetAtTime(450 + revC * 1050, t, 0.05);

    // Grumble throb — slower/heavier; present at all revs
    this.grumbleLFO.frequency.setTargetAtTime(6 + revC * 3, t, 0.1);

    // Light on-power bite
    this.driveGain.gain.setTargetAtTime(throttle ? 0.9 : 0.75, t, 0.1);

    // High whistle note: kept, but MUCH quieter now — just a faint top layer.
    const noteHz = 800 + revC * 2600;
    const whistleVol = 0.13 + revC * 0.1 + (throttle ? 0.04 : 0);
    this.turboGain.gain.setTargetAtTime(whistleVol, t, 0.1);
    this.turboBP.frequency.setTargetAtTime(noteHz, t, 0.12);
    this.turboLP.frequency.setTargetAtTime(noteHz * 1.4, t, 0.12);

    // MAIN voice: the deep, grumbly engine — prominent and heavy.
    const vol = 0.5 + revC * 0.4 + (throttle ? 0.05 : 0);
    this.engineGain.gain.setTargetAtTime(vol, t, 0.05);

    // Grumble depth: strong and roughly constant across the rev range (scaled
    // with volume so it stays grumbly as revs climb), easing off only when
    // almost at the redline (top ~15% of revs).
    const grumbleFrac = revC < 0.85 ? 0.62 : Math.max(0.12, 0.62 - (revC - 0.85) / 0.15 * 0.5);
    this.grumbleDepth.gain.setTargetAtTime(vol * grumbleFrac, t, 0.08);
  }
}

export const engineAudio = new EngineAudio();
