// Creates and manages the shadow DOM host for all Vibe UI.

import { VIBE_STYLES } from './styles.js';
import VibeAPI from './api-bridge.js';
import VibeEvents from './event-bus.js';

let hostEl = null;
let shadowRoot = null;
let layerObserver = null;
let layerQueued = false;
let interaction = { inspecting: false, region: false, gesture: null };

function publishState() {
  hostEl?.dispatchEvent(new CustomEvent('vibe-ui:state', {
    bubbles: true, composed: true,
    detail: { ...interaction, active: !!isVisible() },
  }));
}

function setInteraction(change) {
  interaction = { ...interaction, ...change };
  publishState();
}

// A top-layer popover outside a native modal is still inert. Keep this same host
// inside the active modal; never disable the application's trap or make our UI modal.
function syncLayer(raise = false) {
  if (!isVisible()) return;
  const modals = document.querySelectorAll('dialog:modal');
  hostEl.removeAttribute('aria-hidden');
  const parent = modals[modals.length - 1] || document.body;
  const moved = hostEl.parentNode !== parent;
  if (moved) {
    if (typeof parent.moveBefore === 'function' && hostEl.isConnected) parent.moveBefore(hostEl, null);
    else parent.appendChild(hostEl);
  }
  if (typeof hostEl.showPopover !== 'function') return;
  const focused = shadowRoot.activeElement;
  if (raise && hostEl.matches(':popover-open')) hostEl.hidePopover();
  if (!hostEl.matches(':popover-open')) hostEl.showPopover();
  if ((raise || moved) && focused?.isConnected) focused.focus({ preventScroll: true });
}

function promote() {
  syncLayer(true);
}

function onPageToggle(event) {
  if (event.target === hostEl || event.composedPath().includes(hostEl) || layerQueued) return;
  layerQueued = true;
  queueMicrotask(() => {
    layerQueued = false;
    syncLayer(event.newState === 'open');
  });
}

function watchLayer() {
  if (layerObserver) return;
  layerObserver = new MutationObserver(() => syncLayer());
  layerObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-hidden'] });
  document.addEventListener('beforetoggle', onPageToggle, true);
}

function unwatchLayer() {
  layerObserver?.disconnect();
  layerObserver = null;
  document.removeEventListener('beforetoggle', onPageToggle, true);
}

function init() {
  if (hostEl) return shadowRoot;

  hostEl = document.createElement('div');
  hostEl.id = 'vibe-annotations-root';
  hostEl.setAttribute('popover', 'manual');
  hostEl.style.cssText = `
    position: fixed !important;
    inset: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    background: transparent !important;
    color: inherit !important;
    width: 100vw !important;
    height: 100vh !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
    overflow: visible !important;
  `;

  shadowRoot = hostEl.attachShadow({ mode: 'open' });

  // Inject styles synchronously
  const styleEl = document.createElement('style');
  styleEl.textContent = VIBE_STYLES;
  shadowRoot.appendChild(styleEl);

  // Hidden state is checked async in content.js after init
  // Start hidden to avoid flash, content.js will show if not hidden
  hostEl.style.display = 'none';

  document.body.appendChild(hostEl);
  // MAIN pins this object, not an arbitrary page element with a matching id.
  hostEl.dispatchEvent(new CustomEvent('vibe-ui:register', { bubbles: true, composed: true }));
  publishState();

  // Contain composed events at shadow boundary — prevents frameworks
  // from interpreting shadow DOM interactions as "outside clicks"
  for (const type of ['pointerdown', 'mousedown', 'click', 'focusin', 'focusout']) {
    hostEl.addEventListener(type, (e) => e.stopPropagation());
  }

  return shadowRoot;
}

function getRoot() {
  return shadowRoot;
}

function getHost() {
  return hostEl;
}

function destroy() {
  VibeEvents.emit('ui:deactivate');
  unwatchLayer();
  interaction = { inspecting: false, region: false, gesture: null };
  if (hostEl) {
    hostEl.style.display = 'none';
    publishState();
    if (hostEl.matches(':popover-open')) hostEl.hidePopover();
    hostEl.remove();
  }
  hostEl = null;
  shadowRoot = null;
}

function hide() {
  VibeEvents.emit('ui:deactivate');
  interaction = { inspecting: false, region: false, gesture: null };
  if (hostEl) {
    hostEl.style.display = 'none';
    publishState();
    if (hostEl.matches(':popover-open')) hostEl.hidePopover();
  }
  unwatchLayer();
  VibeAPI.saveOverlayHidden(true);
}

function show() {
  if (hostEl) {
    hostEl.style.display = '';
    publishState();
    watchLayer();
    promote();
  }
  VibeAPI.saveOverlayHidden(false);
  VibeEvents.emit('overlay:shown');
}

function isVisible() {
  return hostEl && hostEl.style.display !== 'none';
}

function toggle() {
  if (isVisible()) { hide(); } else { show(); }
}

const VibeShadowHost = { init, getRoot, getHost, destroy, hide, show, isVisible, toggle, setInteraction, promote };
export default VibeShadowHost;
