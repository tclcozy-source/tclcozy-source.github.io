// Centralised input state — keyboard (desktop only).
export const input = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  shiftUp: false,        // one-shot: set on press, consumed by the car
  shiftDown: false,      // one-shot
  ignitionToggle: false, // one-shot: I
  startEngine: false,    // one-shot: Ctrl+I
  toggleTransmission: false, // one-shot: T (auto/manual)
  toggleView: false,     // one-shot: C (chase / cockpit)
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
    if (e.key === 't' || e.key === 'T') { input.toggleTransmission = true; e.preventDefault(); }
    if (e.key === 'c' || e.key === 'C') { input.toggleView = true; e.preventDefault(); }
  }
});
window.addEventListener('keyup', (e) => {
  if (keyMap[e.key]) { input[keyMap[e.key]] = false; }
});

// Clickable on-screen buttons (ignition / start / transmission)
function bindClick(id, action) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', () => { input[action] = true; });
}

bindClick('btn-ignition',     'ignitionToggle');
bindClick('btn-start',        'startEngine');
bindClick('btn-transmission', 'toggleTransmission');
