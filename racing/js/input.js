// Centralised input state — keyboard + touch
export const input = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  shiftUp: false,        // one-shot: set on press, consumed by the car
  shiftDown: false,      // one-shot
  ignitionToggle: false, // one-shot: I
  startEngine: false,    // one-shot: Ctrl+I
};

// Held-direction keys
const keyMap = {
  ArrowUp: 'forward',    w: 'forward',  W: 'forward',
  ArrowDown: 'backward', s: 'backward', S: 'backward',
  ArrowLeft: 'left',     a: 'left',     A: 'left',
  ArrowRight: 'right',   d: 'right',    D: 'right',
};

window.addEventListener('keydown', (e) => {
  if (keyMap[e.key]) { input[keyMap[e.key]] = true; e.preventDefault(); }

  // Edge-triggered actions — ignore auto-repeat while held
  if (!e.repeat) {
    if (e.key === 'e' || e.key === 'E') { input.shiftUp = true;   e.preventDefault(); }
    if (e.key === 'q' || e.key === 'Q') { input.shiftDown = true; e.preventDefault(); }
    if (e.key === 'i' || e.key === 'I') {
      if (e.ctrlKey) input.startEngine = true;     // Ctrl+I: start engine
      else           input.ignitionToggle = true;  // I: ignition on/off
      e.preventDefault();
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (keyMap[e.key]) { input[keyMap[e.key]] = false; }
});

// Held touch buttons (steer / throttle / brake)
function bindHold(id, action) {
  const btn = document.getElementById(id);
  if (!btn) return;

  const on  = () => { input[action] = true;  btn.classList.add('pressed'); };
  const off = () => { input[action] = false; btn.classList.remove('pressed'); };

  btn.addEventListener('pointerdown',   on,  { passive: true });
  btn.addEventListener('pointerup',     off, { passive: true });
  btn.addEventListener('pointercancel', off, { passive: true });
  btn.addEventListener('pointerleave',  off, { passive: true });
}

// One-shot touch buttons (gear shifts)
function bindTap(id, action) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('pointerdown', () => {
    input[action] = true;
    btn.classList.add('pressed');
  }, { passive: true });
  const release = () => btn.classList.remove('pressed');
  btn.addEventListener('pointerup',     release, { passive: true });
  btn.addEventListener('pointercancel', release, { passive: true });
  btn.addEventListener('pointerleave',  release, { passive: true });
}

bindHold('btn-accel', 'forward');
bindHold('btn-brake', 'backward');
bindHold('btn-left',  'left');
bindHold('btn-right', 'right');
bindTap('btn-upshift',   'shiftUp');
bindTap('btn-downshift', 'shiftDown');
bindTap('btn-ignition',  'ignitionToggle');
bindTap('btn-start',     'startEngine');
