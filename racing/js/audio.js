// Engine sound — a REAL recorded car engine loop, no synthesis.
//
// File: assets/engine_car.mp3 (a real recorded car engine loop from
// OpenGameArt.org, CC-BY). It is played through a plain HTML5 <audio> element,
// looped continuously while the engine runs, with volume and playbackRate
// nudged by RPM. No oscillators, no Web Audio synthesis.

const ENGINE_URL   = new URL('../assets/engine_car.mp3', import.meta.url);
const COAST_VOL    = 0.70; // running, off the throttle
const ACCEL_VOL    = 1.00; // running, accelerating (full volume)
const RATE_IDLE    = 0.85; // playbackRate at idle
const RATE_REDLINE = 1.90; // playbackRate at the redline (kept within 0.8–2.0)

class EngineAudio {
  constructor() {
    this.audio = null;
    this.ready = false;
  }

  _init() {
    if (this.audio) return;
    const a = this.audio = new Audio(ENGINE_URL.href);
    a.loop = true;
    a.preload = 'auto';
    a.volume = 0;
    a.playbackRate = RATE_IDLE;
    this.ready = true;
  }

  // Browsers require a user gesture before audio can play — create the element
  // on the first key/click so it's ready when the engine is started.
  attachAutoResume() {
    const unlock = () => this._init();
    ['keydown', 'pointerdown', 'mousedown'].forEach((ev) =>
      window.addEventListener(ev, unlock, { passive: true }));
  }

  // Per-frame: loop the real engine while running; nudge volume + playbackRate.
  update(running, throttle, rpm) {
    if (!this.ready) this._init();
    if (!this.ready) return;
    const a = this.audio;

    if (running) {
      if (a.paused) a.play().catch(() => {});
      const targetVol = throttle ? ACCEL_VOL : COAST_VOL;
      a.volume = clamp01(a.volume + (targetVol - a.volume) * 0.12);

      const rev = Math.max(0, Math.min((rpm - 900) / (7200 - 900), 1));
      const targetRate = RATE_IDLE + rev * (RATE_REDLINE - RATE_IDLE);
      a.playbackRate += (targetRate - a.playbackRate) * 0.12;
    } else {
      a.volume = clamp01(a.volume + (0 - a.volume) * 0.12);
      if (a.volume < 0.02 && !a.paused) a.pause();
    }
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export const engineAudio = new EngineAudio();
