// Manual region capture: resolve with a viewport CSS box or null when cancelled.
import VibeShadowHost from './shadow-host.js';

const MIN_SIZE = 4;
let active = null;

function isActive() {
  return !!active;
}

function viewportGeometry() {
  const visual = window.visualViewport;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    visualWidth: visual?.width ?? window.innerWidth,
    visualHeight: visual?.height ?? window.innerHeight,
    visualOffsetLeft: visual?.offsetLeft ?? 0,
    visualOffsetTop: visual?.offsetTop ?? 0,
    visualScale: visual?.scale ?? 1,
    dpr: window.devicePixelRatio || 1,
  };
}

function sameGeometry(a, b) {
  return Object.keys(a).every(key => Math.abs(a[key] - b[key]) < 0.01);
}

function start({ onCancel: notifyCancellation } = {}) {
  if (active) return active.promise;
  const root = VibeShadowHost.getRoot();
  if (!root) return Promise.resolve(null);

  let resolveSelection;
  const promise = new Promise(resolve => { resolveSelection = resolve; });
  const geometry = viewportGeometry();
  const shade = document.createElement('div');
  shade.className = 'vibe-region-shade';
  shade.style.touchAction = 'none';
  shade.style.overscrollBehavior = 'none';
  const dim = document.createElement('div');
  dim.className = 'vibe-region-dim';
  const rectEl = document.createElement('div');
  rectEl.className = 'vibe-region-rect';
  const hint = document.createElement('div');
  hint.className = 'vibe-region-hint';
  hint.textContent = 'Drag to capture an area · Esc to cancel';
  shade.append(dim, rectEl, hint);
  root.appendChild(shade);

  let pointerId = null;
  let anchorX = 0;
  let anchorY = 0;
  let settled = false;

  function boxFrom(x1, y1, x2, y2) {
    const minX = geometry.visualOffsetLeft;
    const minY = geometry.visualOffsetTop;
    const maxX = Math.min(geometry.width, minX + geometry.visualWidth);
    const maxY = Math.min(geometry.height, minY + geometry.visualHeight);
    const left = Math.max(minX, Math.min(maxX, Math.min(x1, x2)));
    const top = Math.max(minY, Math.min(maxY, Math.min(y1, y2)));
    const right = Math.max(minX, Math.min(maxX, Math.max(x1, x2)));
    const bottom = Math.max(minY, Math.min(maxY, Math.max(y1, y2)));
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function paint(box) {
    rectEl.style.display = 'block';
    rectEl.style.left = `${box.left}px`;
    rectEl.style.top = `${box.top}px`;
    rectEl.style.width = `${box.width}px`;
    rectEl.style.height = `${box.height}px`;
    hint.textContent = `${Math.round(box.width)} × ${Math.round(box.height)} · release to capture · Esc to cancel`;
  }

  function swallowTrailingInteraction() {
    const types = ['click', 'mouseup', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'];
    const swallow = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const detach = () => types.forEach(type => window.removeEventListener(type, swallow, true));
    types.forEach(type => window.addEventListener(type, swallow, true));
    setTimeout(detach, 400);
  }

  function cleanup(result, reason) {
    if (settled) return;
    settled = true;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onBlur, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    document.removeEventListener('visibilitychange', onVisibilityChange, true);
    shade.removeEventListener('pointerdown', onDown);
    shade.removeEventListener('pointermove', onMove);
    shade.removeEventListener('pointerup', onUp);
    shade.removeEventListener('pointercancel', onCancel);
    shade.removeEventListener('lostpointercapture', onLostCapture);
    shade.removeEventListener('wheel', preventGesture);
    shade.removeEventListener('touchmove', preventGesture);
    window.removeEventListener('wheel', preventGesture, true);
    window.removeEventListener('touchmove', preventGesture, true);
    window.visualViewport?.removeEventListener('resize', onViewportChange);
    window.visualViewport?.removeEventListener('scroll', onViewportChange);
    if (pointerId !== null) {
      try { if (shade.hasPointerCapture(pointerId)) shade.releasePointerCapture(pointerId); } catch { /* pointer is gone */ }
    }
    shade.remove();
    active = null;
    if (reason) notifyCancellation?.(reason);
    resolveSelection(result);
  }

  function cancel(reason = 'Region selection cancelled.') {
    cleanup(null, reason);
  }

  function onViewportChange() {
    if (!sameGeometry(geometry, viewportGeometry())) cancel('Region selection cancelled because the page viewport, scroll position, or zoom changed.');
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') cancel('Region selection cancelled because the tab is no longer visible.');
  }

  function preventGesture(event) {
    event.preventDefault();
  }

  function onDown(event) {
    if (!event.isPrimary || event.button !== 0 || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    anchorX = event.clientX;
    anchorY = event.clientY;
    dim.style.display = 'none';
    try { shade.setPointerCapture(pointerId); } catch { cancel('Region selection cancelled because pointer capture was lost.'); return; }
    paint(boxFrom(anchorX, anchorY, anchorX, anchorY));
  }

  function onMove(event) {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    paint(boxFrom(anchorX, anchorY, event.clientX, event.clientY));
  }

  function onUp(event) {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    const box = boxFrom(anchorX, anchorY, event.clientX, event.clientY);
    pointerId = null;
    if (box.width < MIN_SIZE || box.height < MIN_SIZE) {
      swallowTrailingInteraction();
      cleanup(null, 'Select a region at least 4 CSS pixels wide and high.');
      return;
    }
    if (!sameGeometry(geometry, viewportGeometry())) {
      cancel('Region selection cancelled because the page viewport, scroll position, or zoom changed.');
      return;
    }
    swallowTrailingInteraction();
    cleanup({ ...box, viewport: geometry });
  }

  function onCancel(event) {
    if (event.pointerId !== pointerId) return;
    swallowTrailingInteraction();
    cancel('Region selection cancelled because the pointer interaction was interrupted.');
  }

  function onLostCapture(event) {
    if (event.pointerId === pointerId) cancel('Region selection cancelled because pointer capture was lost.');
  }

  function onBlur(event) {
    // Capture-phase blur also sees the card's textarea losing focus to the shade.
    if (event.target === window) cancel('Region selection cancelled because the window lost focus.');
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel('Region selection cancelled.');
    } else if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) {
      event.preventDefault();
    } else if ([' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
    }
  }

  shade.addEventListener('pointerdown', onDown);
  shade.addEventListener('pointermove', onMove);
  shade.addEventListener('pointerup', onUp);
  shade.addEventListener('pointercancel', onCancel);
  shade.addEventListener('lostpointercapture', onLostCapture);
  shade.addEventListener('wheel', preventGesture, { passive: false });
  shade.addEventListener('touchmove', preventGesture, { passive: false });
  window.addEventListener('wheel', preventGesture, { capture: true, passive: false });
  window.addEventListener('touchmove', preventGesture, { capture: true, passive: false });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);
  document.addEventListener('visibilitychange', onVisibilityChange, true);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('scroll', onViewportChange);

  active = { promise, cancel };
  return promise;
}

function cancel(reason) {
  active?.cancel(reason || 'Region selection cancelled.');
}

const VibeRegionCapture = { start, isActive, cancel };
export default VibeRegionCapture;
