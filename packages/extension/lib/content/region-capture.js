// Manual region capture: dim the page, let the user drag a rectangle, resolve with the
// rect in CSS px (viewport coordinates) or null when cancelled.
//
// The interaction surface lives in the shadow root, so the page keeps its real layout
// and our own styles apply. Because that surface is our UI, page listeners never see
// these events (see the MAIN-world isolation patch in bridge.content.js) — dragging a
// region over a modal dialog cannot close it.

import VibeShadowHost from './shadow-host.js';

const MIN_SIZE = 4; // CSS px — anything smaller is a stray click, not a selection

let active = null;

function isActive() {
  return !!active;
}

function start() {
  if (active) return active.promise;
  const root = VibeShadowHost.getRoot();
  if (!root) return Promise.resolve(null);

  let resolveSelection;
  const promise = new Promise((resolve) => { resolveSelection = resolve; });

  const shade = document.createElement('div');
  shade.className = 'vibe-region-shade';
  const dim = document.createElement('div');
  dim.className = 'vibe-region-dim';
  const rectEl = document.createElement('div');
  rectEl.className = 'vibe-region-rect';
  const hint = document.createElement('div');
  hint.className = 'vibe-region-hint';
  hint.textContent = 'Drag to capture an area · Esc to cancel';
  shade.append(dim, rectEl, hint);
  root.appendChild(shade);

  let dragging = false;
  let anchorX = 0;
  let anchorY = 0;

  // Clamped to the viewport: captureVisibleTab only returns what is visible.
  function boxFrom(x1, y1, x2, y2) {
    const left = Math.max(0, Math.min(x1, x2));
    const top = Math.max(0, Math.min(y1, y2));
    const right = Math.min(window.innerWidth, Math.max(x1, x2));
    const bottom = Math.min(window.innerHeight, Math.max(y1, y2));
    return { left, top, width: right - left, height: bottom - top };
  }

  function paint(box) {
    rectEl.style.display = 'block';
    rectEl.style.left = `${box.left}px`;
    rectEl.style.top = `${box.top}px`;
    rectEl.style.width = `${box.width}px`;
    rectEl.style.height = `${box.height}px`;
    hint.textContent = `${Math.round(box.width)} × ${Math.round(box.height)} · release to capture · Esc to cancel`;
  }

  // pointerup is followed by a click at whatever sits under the cursor. Swallow those
  // for a moment, or the page reacts to a drag that belonged to us (a modal backdrop
  // closes, a button fires).
  function swallowTrailingInteraction() {
    const types = ['click', 'mouseup', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'];
    const swallow = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const detach = () => types.forEach((t) => window.removeEventListener(t, swallow, true));
    types.forEach((t) => window.addEventListener(t, swallow, true));
    setTimeout(detach, 400);
  }

  function cleanup(result) {
    window.removeEventListener('keydown', onKeyDown, true);
    shade.removeEventListener('pointerdown', onDown);
    shade.removeEventListener('pointermove', onMove);
    shade.removeEventListener('pointerup', onUp);
    shade.removeEventListener('pointercancel', onCancel);
    shade.remove();
    active = null;
    resolveSelection(result);
  }

  function finish(box) {
    const valid = box && box.width >= MIN_SIZE && box.height >= MIN_SIZE;
    if (valid) paint(box);
    swallowTrailingInteraction();
    cleanup(valid ? box : null);
  }

  function onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    anchorX = e.clientX;
    anchorY = e.clientY;
    dim.style.display = 'none'; // the rect's own shadow dims everything outside
    try { shade.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    paint(boxFrom(anchorX, anchorY, anchorX, anchorY));
  }

  function onMove(e) {
    if (!dragging) return;
    paint(boxFrom(anchorX, anchorY, e.clientX, e.clientY));
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    try { shade.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    finish(boxFrom(anchorX, anchorY, e.clientX, e.clientY));
  }

  function onCancel() {
    dragging = false;
    finish(null);
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation(); // the popover must not treat this as "close me"
    cleanup(null);
  }

  shade.addEventListener('pointerdown', onDown);
  shade.addEventListener('pointermove', onMove);
  shade.addEventListener('pointerup', onUp);
  shade.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeyDown, true);

  active = { promise, cancel: () => cleanup(null) };
  return promise;
}

function cancel() {
  active?.cancel();
}

const VibeRegionCapture = { start, isActive, cancel };
export default VibeRegionCapture;
