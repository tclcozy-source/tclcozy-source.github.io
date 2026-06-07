// Floating, Roblox-style analog joystick for mobile.
// Drag anywhere in the left zone: up = accelerate, down = brake/reverse,
// left/right = steer. Writes to the shared input object.
import { input } from './input.js';

const MAX_RADIUS = 64;   // px the knob can travel from the base centre
const THROTTLE_DEADZONE = 0.22;
const STEER_DEADZONE    = 0.08;

export function initJoystick() {
  const zone = document.getElementById('joystick-zone');
  const base = document.getElementById('joystick-base');
  const knob = document.getElementById('joystick-knob');
  if (!zone || !base || !knob) return;

  let activeId = null;
  let cx = 0, cy = 0; // base centre (where the finger first landed)

  const reset = () => {
    activeId = null;
    base.style.display = 'none';
    input.steerAxis = 0;
    input.forward = false;
    input.backward = false;
  };

  const setKnob = (dx, dy) => {
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  };

  function onDown(e) {
    if (activeId !== null) return;        // already tracking a finger
    activeId = e.pointerId;
    cx = e.clientX;
    cy = e.clientY;
    base.style.left = cx + 'px';
    base.style.top = cy + 'px';
    base.style.display = 'block';
    setKnob(0, 0);
    try { zone.setPointerCapture(e.pointerId); } catch (err) {}
    onMove(e);
  }

  function onMove(e) {
    if (e.pointerId !== activeId) return;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_RADIUS) { dx = (dx / dist) * MAX_RADIUS; dy = (dy / dist) * MAX_RADIUS; }
    setKnob(dx, dy);

    const nx =  dx / MAX_RADIUS;  // -1 (left) .. +1 (right)
    const ny = -dy / MAX_RADIUS;  // -1 (down) .. +1 (up)

    // steerAxis: +1 = turn left (matches the keyboard's left). Push right -> negative.
    input.steerAxis = Math.abs(nx) > STEER_DEADZONE ? -nx : 0;
    input.forward  = ny >  THROTTLE_DEADZONE;
    input.backward = ny < -THROTTLE_DEADZONE;
  }

  zone.addEventListener('pointerdown', onDown, { passive: true });
  zone.addEventListener('pointermove', onMove, { passive: true });
  zone.addEventListener('pointerup', (e) => { if (e.pointerId === activeId) reset(); }, { passive: true });
  zone.addEventListener('pointercancel', (e) => { if (e.pointerId === activeId) reset(); }, { passive: true });
}
