// Own only the pointer sequence that selected an element/region, never a click window.
import VibeShadowHost from './shadow-host.js';
import VibeEvents from './event-bus.js';

let gesture = null;
let expiry = null;
const types = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click'];

function publish() {
  VibeShadowHost.setInteraction({ gesture: gesture && { pointerId: gesture.pointerId, phase: gesture.phase } });
}

function clear() {
  clearTimeout(expiry);
  expiry = null;
  gesture = null;
  for (const type of types) window.removeEventListener(type, guard, true);
  window.removeEventListener('blur', onBlur, true);
  document.removeEventListener('visibilitychange', onVisibility, true);
  publish();
}

function onBlur(event) { if (event.target === window) clear(); }
function onVisibility() { if (document.visibilityState !== 'visible') clear(); }

function guard(event) {
  if (!gesture) return;
  // Even the same mouse pointer id starts an independent gesture at its next down.
  if (event.type === 'pointerdown') { clear(); return; }
  if (event.type.startsWith('pointer') || event.type === 'click') {
    if (event.pointerId !== gesture.pointerId) return;
  }
  if (event.type === 'pointercancel') { clear(); return; }
  const fromHost = event.composedPath().includes(VibeShadowHost.getHost());
  if (event.type === 'pointerup') {
    gesture.phase = 'up';
    publish();
    clearTimeout(expiry);
    // Only a lost click needs a timeout. Holding the pointer never expires the guard.
    expiry = setTimeout(clear, 1500);
  }
  if (!(fromHost && event.type !== 'click')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  if (event.type === 'click') clear();
}

function begin(event) {
  clear();
  gesture = { pointerId: event.pointerId, phase: 'down' };
  publish();
  for (const type of types) window.addEventListener(type, guard, true);
  window.addEventListener('blur', onBlur, true);
  document.addEventListener('visibilitychange', onVisibility, true);
}

VibeEvents.on('ui:deactivate', clear);
const VibeGestureGuard = { begin, clear };
export default VibeGestureGuard;
