// Floating pill toolbar — always visible, bottom-right by default
// Draggable, collapsible, position persisted to storage
// Settings dropdown with theme toggle, MCP status, local image controls

import VibeAPI from './api-bridge.js';
import VibeElementContext from './element-context.js';
import VibeEvents, { vibeLocationPath } from './event-bus.js';
import VibeShadowHost from './shadow-host.js';
import VibeToolbarDocs from './toolbar-docs.js';
import { openExportReview } from './local-export.js';
import { isRecordableHotkey } from './hotkey.js';
import { isReviewable, variantContext, currentVariant, variantElement, previewVariant, chooseVariant } from './variants.js';

  let toolbarEl = null;
  let settingsDropdown = null;
  let activeRecordingCleanup = null;
  let isAnnotating = false;
  let serverOnline = false;
  let serverOutdated = false; // connected but older than the extension needs
  let annotationCount = 0;
  let styleAnnotationCount = 0;
  let badgeColor = '#D03D68';
  let watcherActive = false;
  let isOverlayVisible = true;
  let claudeConnected = false; // Claude Code mod is polling the server
  let inProgressIds = new Set(); // shown in progress: the server's list plus justSent
  let serverProgressIds = new Set(); // handed to a live Claude session, per the server
  // What this page just sent, shown in progress until the server confirms it
  // (the mod picks a send up on its next poll) or the window runs out.
  let justSent = { ids: new Set(), until: 0 };
  const JUST_SENT_MS = 20000;
  let unsentCount = 0; // this site's annotations Send would hand over

  const BADGE_COLORS = ['#D03D68', '#4b5563', '#3b82f6', '#22c55e', '#a855f7'];

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  // Embedded Chromium hosts (Electron, etc.) have no extension toolbar icon and no
  // chrome.commands shortcut, so closing the overlay would be a one-way door with no
  // way to reopen it. Hide the close button there — the toolbar stays put instead.
  const isEmbeddedHost = /\bElectron\//.test(navigator.userAgent);
  const defaultShortcutHint = isMac ? '\u2318\u21E7,' : 'Ctrl+Shift+,';
  let shortcutHint = defaultShortcutHint;
  let customShortcut = null;

  const ICONS = {
    annotate: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>',
    crosshair: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/></svg>',
    serverRack: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>',
    collapse: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    // Vibe logo — actual icon (set dynamically in buildToolbar)
    logo: '',
    // Links
    github: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>',
    server: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
    camera: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    keyboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>',
    newspaper: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg>',
    palette: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.3-.3-.4-.7-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-5.5-4.5-10-10-10z"/></svg>',
    rocket: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    clipboard: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    chevronRight: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    upload: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    users: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    webpage: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
    globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
    robot: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>',
    book: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>',
    layers: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12.75l8.6 3.9a2 2 0 0 0 1.65 0l8.58-3.9"/><path d="M2 17.25l8.6 3.9a2 2 0 0 0 1.65 0l8.58-3.9"/></svg>',
    send: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/></svg>',
    eye: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  };

  async function init() {
    const root = VibeShadowHost.getRoot();
    if (!root) return;

    badgeColor = await VibeAPI.getBadgeColor();
    applyBadgeColor(badgeColor);
    customShortcut = await VibeAPI.getCustomShortcut();
    if (customShortcut) shortcutHint = formatShortcut(customShortcut);
    await refreshServerStatus();

    buildToolbar(root);
    isOverlayVisible = true;
    await restorePosition();

    // Listen for events
    VibeEvents.on('inspection:started', () => { isAnnotating = true; updateUI(); });
    VibeEvents.on('inspection:stopped', () => { isAnnotating = false; updateUI(); });
    VibeEvents.on('badges:rendered', ({ count, total, styleCount }) => { annotationCount = total; styleAnnotationCount = 0; updateUI(); refreshUnsent(); });
    VibeEvents.on('annotations:cleared', () => { annotationCount = 0; styleAnnotationCount = 0; updateUI(); });
    VibeEvents.on('overlay:closed', () => { overlayOpen = false; isOverlayVisible = false; stopPolling(); });
    VibeEvents.on('overlay:shown', async () => { overlayOpen = true; isOverlayVisible = true; startPolling(); await restorePosition(); animateToolbarIn(); });

    window.removeEventListener('resize', handleWindowResize);
    window.addEventListener('resize', handleWindowResize, { passive: true });

    // Pause polling while the tab is backgrounded — a hidden tab isn't being
    // actively used, so there's no reason to keep checking the server (issue #84).
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling();
      else if (overlayOpen) startPolling();
    });

    // Start periodic checks only when the overlay is actually up and the tab is
    // visible. A closed overlay resumes on 'overlay:shown', a background tab via
    // the visibilitychange handler above.
    overlayOpen = !(await VibeAPI.getOverlayHidden());
    if (overlayOpen && !document.hidden) startPolling();
  }

  let overlayOpen = false;
  let serverPollTimer = null;
  let watcherPollId = null;
  let serverPollActive = false;
  let serverPollGen = 0; // bumped on every start/stop so a superseded loop exits
  const SERVER_POLL_INTERVAL = 10000;

  function startPolling() {
    if (!serverPollActive) {
      serverPollActive = true;
      runServerPoll(++serverPollGen, true); // live check on open/focus, then self-schedules
    }
    if (!watcherPollId) {
      refreshWatchers();
      // 10s rather than 5s: watch mode is toggled by the agent, not the user, so
      // a slightly later indicator update is invisible — and it halves the idle
      // request rate. Skipped entirely while the server is offline.
      watcherPollId = setInterval(refreshWatchers, 10000);
    }
  }

  // Self-scheduling status poll. This reads the background worker's cached
  // health state rather than hitting the server from the page (issue #84), so
  // the only cost per tick is a runtime message. No backoff here: the worker
  // already backs off its own /health probes while the server is down, and a
  // second backoff on top only delays the toolbar noticing a reconnect (up to
  // 60s). `fresh` forces a live probe — used when the toolbar opens or the tab
  // regains focus, where a stale answer would be visible to the user. `gen`
  // guards against a close→reopen landing mid-await: the old loop would
  // otherwise resume alongside the new one and orphan a timer.
  async function runServerPoll(gen, fresh = false) {
    if (gen !== serverPollGen) return;
    await refreshServerStatus(fresh);
    if (gen !== serverPollGen) return;
    serverPollTimer = setTimeout(() => runServerPoll(gen), SERVER_POLL_INTERVAL);
  }

  function stopPolling() {
    serverPollActive = false;
    serverPollGen++;
    if (serverPollTimer) { clearTimeout(serverPollTimer); serverPollTimer = null; }
    if (watcherPollId) { clearInterval(watcherPollId); watcherPollId = null; }
  }

  let viewAllPanel = null;

  function buildToolbar(root) {
    const logoUrl = chrome.runtime.getURL('assets/icons/icon-hq.png');

    toolbarEl = document.createElement('div');
    toolbarEl.className = 'vibe-toolbar';

    toolbarEl.innerHTML = `
      <img class="vibe-toolbar-logo" src="${logoUrl}" alt="ng-vibe-remarker" title="ng-vibe-remarker" />
      <div class="vibe-toolbar-separator"></div>
      <div class="vibe-toolbar-middle">
        <div class="vibe-toolbar-default">
          <button class="vibe-toolbar-btn vibe-tb-annotate" title="Annotate (${shortcutHint})">
            ${ICONS.annotate}
            <span>Annotate</span>
          </button>
          <button class="vibe-toolbar-btn vibe-tb-viewall" title="View all annotations">
            ${ICONS.list}
            <span>View all</span>
            <span class="vibe-toolbar-pill" style="display:none">0</span>
          </button>
          <button class="vibe-toolbar-btn vibe-tb-settings" title="Settings">
            ${ICONS.settings}
            <span>Settings</span>
          </button>
          <button class="vibe-toolbar-status vibe-tb-status" title="Offline" style="margin-left:4px;">
            ${ICONS.serverRack}
          </button>
          <button class="vibe-toolbar-send vibe-tb-send" title="Send to Claude Code" aria-label="Send to Claude Code" style="display:none">
            ${ICONS.send}
          </button>
        </div>
        <div class="vibe-toolbar-annotating">
          <span class="vibe-toolbar-instruction">Click to capture</span>
          <span class="vibe-toolbar-dot"></span>
          <kbd class="vibe-toolbar-kbd">↑</kbd>
          <kbd class="vibe-toolbar-kbd">↓</kbd>
          <kbd class="vibe-toolbar-kbd">⏎</kbd>
          <span class="vibe-toolbar-instruction">to fine-tune target</span>
          <span class="vibe-toolbar-dot"></span>
          <kbd class="vibe-toolbar-kbd">Esc</kbd>
          <span class="vibe-toolbar-instruction">to stop</span>
        </div>
      </div>
      ${isEmbeddedHost ? '' : `
      <div class="vibe-toolbar-separator"></div>
      <button class="vibe-toolbar-close vibe-tb-close" title="Close ng-vibe-remarker">
        ${ICONS.close}
      </button>`}
    `;

    root.appendChild(toolbarEl);
    wireButtons();
    setupDrag();
    updateUI();
    injectUpdateBanner();
  }

  // --- Release banner (shown once after an update, until dismissed) ---
  // RELEASE CHECKLIST: the banner copy below is hardcoded — rewrite it for
  // every Chrome Web Store release, or users see the previous release's pitch.

  async function injectUpdateBanner() {
    try {
      const { updateInfo } = await chrome.storage.local.get(['updateInfo']);
      if (!updateInfo || !updateInfo.hasUpdate || !toolbarEl) return;

      const docsUrl = 'https://vibe-annotations.com/docs/claude-code';
      const installCmd = 'claude plugin install vibe-annotations --marketplace RaphaelRegnier/vibe-annotations';

      // 2.2.0: nudge Claude Code users to the mod — one command gives them the
      // server, the band above the prompt and Send to Claude out of the box.
      const banner = document.createElement('div');
      banner.className = 'vibe-update-banner';
      banner.innerHTML = `
        <div class="vibe-update-body">
          <span class="vibe-update-text">
            <strong>New: send your annotations to Claude Code in one click</strong>,
            and see what it's working on. Install the Claude Code mod:
          </span>
          <div class="vibe-guide-cmd vibe-update-cmd">
            <code>${installCmd}</code>
            <button class="vibe-guide-copy" type="button" title="Copy">${ICONS.clipboard}</button>
          </div>
        </div>
        <a class="vibe-update-link" href="${docsUrl}" target="_blank" rel="noopener">How it works</a>
        <button class="vibe-update-dismiss" title="Dismiss">${ICONS.close}</button>
      `;

      const copyBtn = banner.querySelector('.vibe-update-cmd .vibe-guide-copy');
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(installCmd); } catch { /* clipboard blocked */ }
        copyBtn.innerHTML = ICONS.check;
        setTimeout(() => { copyBtn.innerHTML = ICONS.clipboard; }, 1500);
      });

      const dismiss = () => {
        banner.classList.add('vibe-update-banner-out');
        setTimeout(() => banner.remove(), 200);
        chrome.runtime.sendMessage({ action: 'dismissUpdate' }).catch(() => {});
      };

      banner.querySelector('.vibe-update-dismiss').addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
      });
      // Opening the docs also clears the "NEW" state.
      banner.querySelector('.vibe-update-link').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'dismissUpdate' }).catch(() => {});
      });

      toolbarEl.appendChild(banner);
    } catch (_) { /* storage unavailable — skip banner */ }
  }

  function wireButtons() {
    // Annotate toggle
    toolbarEl.querySelector('.vibe-tb-annotate').addEventListener('click', () => {
      if (isAnnotating) {
        VibeEvents.emit('inspection:stop');
      } else {
        VibeEvents.emit('inspection:start');
      }
    });

    // View all
    toolbarEl.querySelector('.vibe-tb-viewall').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleViewAll();
    });

    // Send to Claude — the Claude Code mod picks it up on its next poll
    toolbarEl.querySelector('.vibe-tb-send').addEventListener('click', (e) => {
      e.stopPropagation();
      if (sessionPicker) closeSessionPicker();
      else sendToClaude();
    });

    // Settings
    toolbarEl.querySelector('.vibe-tb-settings').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettings();
    });

    // Close — animate out then hide. Absent in embedded hosts (see isEmbeddedHost).
    toolbarEl.querySelector('.vibe-tb-close')?.addEventListener('click', () => {
      animateToolbarOut();
    });

    // Status — watching: stop watchers; offline/online: open MCP setup docs
    toolbarEl.querySelector('.vibe-tb-status').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (watcherActive) {
        await VibeAPI.stopWatchers();
        watcherActive = false;
        updateUI();
        VibeEvents.emit('watch:changed', { active: false });
        return;
      }
      closeViewAll();
      closeSettings();
      openSettings();
      // Navigate into Documentation, then MCP setup
      requestAnimationFrame(() => {
        showDocumentation();
        requestAnimationFrame(() => {
          const mcpBtn = settingsDropdown?.querySelector('.vibe-mcp-server-btn');
          if (mcpBtn) mcpBtn.click();
        });
      });
    });
  }

  // --- View All panel (stub — full impl in Phase 6) ---

  function toggleViewAll() {
    if (viewAllPanel) {
      closeViewAll();
    } else {
      closeSettings();
      openViewAll();
    }
  }

  async function openViewAll() {
    closeViewAll();

    const btn = toolbarEl.querySelector('.vibe-tb-viewall');
    if (btn) btn.classList.add('active');

    // Exclude resolved (agent finalized/cleaned them — done). variants-discarded and
    // variant-chosen stay, shown with a "pending agent" label; the count pill matches.
    const annotations = (await VibeAPI.loadProjectAnnotations()).filter(a => a.status !== 'resolved');
    const hostname = window.location.host || window.location.hostname;

    // Group by route (path)
    const routeGroups = {};
    for (const a of annotations) {
      try {
        const path = new URL(a.url).pathname;
        if (!routeGroups[path]) routeGroups[path] = [];
        routeGroups[path].push(a);
      } catch {
        const fallback = '/';
        if (!routeGroups[fallback]) routeGroups[fallback] = [];
        routeGroups[fallback].push(a);
      }
    }

    viewAllPanel = document.createElement('div');
    const rect = toolbarEl.getBoundingClientRect();
    const inLowerHalf = rect.top > window.innerHeight / 2;
    viewAllPanel.className = 'vibe-viewall-panel' + (inLowerHalf ? ' above' : '');

    const trashIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
    const copyIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    const shareIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>';
    const smallTrash = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
    const sparkleIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';

    // Build routes HTML
    let routesHTML = '';
    const sortedPaths = Object.keys(routeGroups).sort();
    for (const path of sortedPaths) {
      const items = routeGroups[path];
      const cardsHTML = items.map(a => {
        const isStylesheet = a.type === 'stylesheet';
        const selector = isStylesheet ? null : (a.selector || a.element_context?.tag || '?');
        const hasPendingChanges = a.pending_changes && Object.keys(a.pending_changes).length > 0;
        const changeCount = hasPendingChanges ? Object.keys(a.pending_changes).length : 0;
        const comment = a.comment || '';

        let headerHTML;
        if (isStylesheet) {
          headerHTML = `<div class="vibe-viewall-design">${sparkleIcon}<span>Stylesheet change</span></div>`;
        } else {
          headerHTML = `<div class="vibe-viewall-selector">${escapeHTML(selector)}</div>`;
        }

        let bodyHTML;
        if (hasPendingChanges && !comment) {
          bodyHTML = `<div class="vibe-viewall-design">${sparkleIcon}<span>${changeCount} design change${changeCount !== 1 ? 's' : ''}</span></div>`;
        } else if (comment) {
          bodyHTML = `<div class="vibe-viewall-comment">${escapeHTML(comment)}</div>`;
          if (hasPendingChanges) {
            bodyHTML += `<div class="vibe-viewall-design" style="margin-top:2px;">${sparkleIcon}<span>${changeCount} design change${changeCount !== 1 ? 's' : ''}</span></div>`;
          }
        } else if (!isStylesheet) {
          bodyHTML = `<div class="vibe-viewall-comment empty">No comment</div>`;
        } else {
          bodyHTML = '';
        }

        // Variant lifecycle chip — signals states that need agent action so the
        // list is self-explanatory (esp. why a "deleted" variant lingers here).
        const vs = variantStatusLabel(a)
          || (inProgressIds.has(a.id) ? { text: 'In progress', cls: 'progress' } : null);
        const statusHTML = vs ? `<div class="vibe-viewall-status ${vs.cls}">${vs.text}</div>` : '';
        const variantsHTML = variantPickerHTML(a);
        // A scaffolded variant can't be hard-deleted (it awaits agent cleanup), so
        // hide the trash for the discarded state to avoid a no-op button.
        const deleteHTML = a.status === 'variants-discarded'
          ? ''
          : `<button class="vibe-viewall-card-delete" data-id="${a.id}" title="Delete">${trashIcon}</button>`;

        return `
          <div class="vibe-viewall-card" data-id="${a.id}">
            <div class="vibe-viewall-card-content">
              ${headerHTML}
              ${bodyHTML}
              ${statusHTML}
              ${variantsHTML}
            </div>
            ${deleteHTML}
          </div>
        `;
      }).join('');

      routesHTML += `
        <div class="vibe-viewall-route" data-path="${escapeHTML(path)}">
          <div class="vibe-viewall-route-header">
            <div class="vibe-viewall-route-left">
              <span class="vibe-viewall-route-path">${escapeHTML(path)}</span>
              <span class="vibe-viewall-route-count">${items.length}</span>
            </div>
            <button class="vibe-viewall-route-clear" data-path="${escapeHTML(path)}" title="Clear route">${smallTrash}</button>
          </div>
          ${cardsHTML}
        </div>
      `;
    }

    if (annotations.length === 0) {
      routesHTML = '<div style="padding:24px 16px;text-align:center;color:var(--v-instruction-text);font-size:13px;">No annotations yet</div>';
    }

    viewAllPanel.innerHTML = `
      <div class="vibe-viewall-header">
        <span class="vibe-viewall-url">${escapeHTML(hostname)}</span>
        <div class="vibe-viewall-actions">
          <button class="vibe-viewall-copy" title="Copy all">${copyIcon}</button>
          <button class="vibe-viewall-export" title="Share / Export">${shareIcon}</button>
          <button class="vibe-viewall-deleteall" title="Delete all">${trashIcon}</button>
        </div>
      </div>
      <div class="vibe-viewall-routes">${routesHTML}</div>
    `;

    toolbarEl.appendChild(viewAllPanel);

    // --- Wire View All actions ---

    const copyBtn = viewAllPanel.querySelector('.vibe-viewall-copy');
    copyBtn.addEventListener('click', async () => {
      const all = (await VibeAPI.loadProjectAnnotations()).filter(a => a.status !== 'resolved');
      if (!all.length) return;
      await openExportReview(all, 'copy');
    });

    // Every export uses the same local review, including copy.
    const shareBtn = viewAllPanel.querySelector('.vibe-viewall-export');
    let shareMenu = null;
    const closeShareMenu = () => { if (shareMenu) { shareMenu.remove(); shareMenu = null; } };
    shareBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (shareMenu) { closeShareMenu(); return; }
      const root = VibeShadowHost.getRoot();
      if (!root) return;
      shareMenu = document.createElement('div');
      shareMenu.className = 'vibe-viewall-share-menu';
      shareMenu.innerHTML = '<button class="vibe-share-opt" type="button"><strong>.zip</strong><span>offline reviewed export</span></button>';
      root.appendChild(shareMenu);
      shareMenu.querySelector('.vibe-share-opt').addEventListener('click', async () => {
        closeShareMenu();
        const all = (await VibeAPI.loadProjectAnnotations()).filter(a => a.status !== 'resolved');
        if (!all.length) return;
        const review = await openExportReview(all);
        if (!review) return;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(review.blob);
        link.download = `vibe-annotations-${window.location.hostname.replace(/[^a-z0-9.-]/gi, '_') || 'annotations'}.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      });
    });
    const onOutsideClick = ev => { if (shareMenu && !shareMenu.contains(ev.target) && ev.target !== shareBtn) closeShareMenu(); };
    VibeShadowHost.getRoot()?.addEventListener('click', onOutsideClick);
    document.addEventListener('click', closeShareMenu);


    // Delete all (animate all cards out with stagger, then delete)
    viewAllPanel.querySelector('.vibe-viewall-deleteall').addEventListener('click', async () => {
      const root = VibeShadowHost.getRoot();
      if (!root) return;
      const skip = await VibeAPI.getSkipDeleteConfirm();
      if (!skip) {
        const confirmed = await showDeleteConfirm(root);
        if (!confirmed) return;
      }
      const allCards = viewAllPanel.querySelectorAll('.vibe-viewall-card');
      allCards.forEach((card, i) => {
        setTimeout(() => card.classList.add('deleting'), i * 40);
      });
      await new Promise(r => setTimeout(r, allCards.length * 40 + 300));
      if (viewAllPanel) viewAllPanel._suppressRefresh = true;
      for (const a of annotations) {
        await VibeAPI.deleteAnnotation(a.id);
      }
      // Re-render so the count pill recomputes immediately (deletes happen in the
      // background service worker, which doesn't push a render to this page).
      VibeEvents.emit('annotations:render', await VibeAPI.loadAnnotations());
      openViewAll();
    });

    // Per-route clear (animate each card out with stagger, then delete)
    viewAllPanel.querySelectorAll('.vibe-viewall-route-clear').forEach(btn => {
      btn.addEventListener('click', async () => {
        const path = btn.dataset.path;
        const routeAnnotations = routeGroups[path] || [];
        const routeEl = btn.closest('.vibe-viewall-route');
        if (routeEl) {
          const cards = routeEl.querySelectorAll('.vibe-viewall-card');
          cards.forEach((card, i) => {
            setTimeout(() => card.classList.add('deleting'), i * 50);
          });
          await new Promise(r => setTimeout(r, cards.length * 50 + 300));
        }
        if (viewAllPanel) viewAllPanel._suppressRefresh = true;
        for (const a of routeAnnotations) {
          await VibeAPI.deleteAnnotation(a.id);
        }
        VibeEvents.emit('annotations:render', await VibeAPI.loadAnnotations());
        openViewAll();
      });
    });

    // Per-card delete (animate out then delete)
    viewAllPanel.querySelectorAll('.vibe-viewall-card-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const card = btn.closest('.vibe-viewall-card');
        if (card) {
          card.classList.add('deleting');
          await new Promise(r => setTimeout(r, 300));
        }
        if (viewAllPanel) viewAllPanel._suppressRefresh = true;
        await VibeAPI.deleteAnnotation(id);
        VibeEvents.emit('annotations:render', await VibeAPI.loadAnnotations());
        openViewAll();
      });
    });

    // Variant pickers: same preview + choose as the badge's popover, for variants
    // whose badge is hard to reach once a variant reshapes the page.
    viewAllPanel.querySelectorAll('.vibe-viewall-variants').forEach(box => {
      const a = annotations.find(x => x.id === box.dataset.id);
      if (!a) return;
      wireVariantPicker(box, a);
    });

    // Click card to scroll to element
    viewAllPanel.querySelectorAll('.vibe-viewall-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.vibe-viewall-card-delete, .vibe-viewall-variants')) return;
        const id = card.dataset.id;
        const a = annotations.find(x => x.id === id);
        if (a && a.selector) {
          try {
            const el = document.querySelector(a.selector);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              VibeEvents.emit('badge:target', { id });
            }
          } catch {}
        }
      });
    });

    // Listen for external annotation changes (e.g. MCP deletion, other tab sync)
    // Skip refresh if the panel itself triggered the change (via delete actions)
    let refreshPending = false;
    const refreshHandler = () => {
      if (!viewAllPanel || refreshPending || viewAllPanel._suppressRefresh) return;
      refreshPending = true;
      setTimeout(() => { refreshPending = false; if (viewAllPanel && !viewAllPanel._suppressRefresh) openViewAll(); }, 600);
    };
    VibeEvents.on('badges:rendered', refreshHandler);

    // Store cleanup reference
    viewAllPanel._cleanupEvents = () => {
      VibeEvents.off('badges:rendered', refreshHandler);
      document.removeEventListener('click', closeShareMenu);
      VibeShadowHost.getRoot()?.removeEventListener('click', onOutsideClick);
      closeShareMenu();
    };
  }

  function closeViewAll() {
    if (viewAllPanel) {
      if (viewAllPanel._cleanupEvents) viewAllPanel._cleanupEvents();
      viewAllPanel.remove();
      viewAllPanel = null;
    }
    const btn = toolbarEl.querySelector('.vibe-tb-viewall');
    if (btn) btn.classList.remove('active');
  }

  // --- Settings dropdown ---

  function toggleSettings() {
    if (settingsDropdown) {
      closeSettings();
    } else {
      closeViewAll();
      openSettings();
    }
  }

  function openSettings() {
    closeSettings();

    const btn = toolbarEl.querySelector('.vibe-tb-settings');
    if (btn) btn.classList.add('active');

    const version = chrome.runtime.getManifest().version;

    settingsDropdown = document.createElement('div');
    const rect = toolbarEl.getBoundingClientRect();
    const inLowerHalf = rect.top > window.innerHeight / 2;
    settingsDropdown.className = 'vibe-settings-dropdown' + (inLowerHalf ? ' above' : '');

    const statusColor = serverOutdated ? 'var(--v-status-watching)' : (serverOnline ? 'var(--v-status-online)' : 'var(--v-status-offline)');
    const statusLabel = serverOutdated ? 'Update available' : (serverOnline ? 'Online' : 'Offline');

    const route = vibeLocationPath(window.location);

    settingsDropdown.innerHTML = `
      <div class="vibe-settings-header">
        <div>
          <span class="vibe-settings-title">${escapeHTML(route)}</span>
          <a href="https://github.com/RaphaelRegnier/vibe-annotations/releases/tag/v${escapeHTML(version)}" target="_blank" rel="noopener" class="vibe-settings-version">v${escapeHTML(version)}</a>
        </div>
      </div>
      <div class="vibe-settings-body">
        <button class="vibe-settings-link vibe-get-started-btn" type="button">
          ${ICONS.book}
          <span>Documentation</span>
          <span style="margin-left:auto;color:var(--v-text-secondary);">${ICONS.chevronRight}</span>
        </button>
        <div class="vibe-settings-separator"></div>
        <div class="vibe-settings-item">
          <div class="vibe-settings-item-left">
            ${ICONS.palette}
            <span>Pin color</span>
          </div>
          <div class="vibe-color-picker" style="display:flex;gap:6px;">
            ${BADGE_COLORS.map(c => `<button class="vibe-color-dot${c === badgeColor ? ' active' : ''}" data-color="${c}" style="background:${c};" type="button"></button>`).join('')}
          </div>
        </div>
        <div class="vibe-settings-item">
          <div class="vibe-settings-item-left">
            ${ICONS.camera}
            <div>
              <span>Local screenshots</span>
              <div style="font-size:11px;color:var(--v-text-secondary);margin-top:1px;">Screenshots stay in this browser and are not sent to the server.</div>
            </div>
          </div>
          <button class="vibe-settings-link vibe-clear-local-images-btn" type="button">Clear local images</button>
        </div>
        <div class="vibe-settings-item">
          <div class="vibe-settings-item-left">
            ${ICONS.keyboard}
            <span>Trigger hotkey</span>
          </div>
          <button class="vibe-shortcut-btn" type="button">${escapeHTML(shortcutHint)}</button>
        </div>
        <div class="vibe-settings-separator"></div>
        <button class="vibe-settings-link vibe-import-btn" type="button">
          ${ICONS.download}
          <span>Import annotations</span>
        </button>
      </div>
    `;

    toolbarEl.appendChild(settingsDropdown);


    settingsDropdown.querySelector('.vibe-clear-local-images-btn').addEventListener('click', async (e) => {
      if (!window.confirm('Clear all locally stored screenshots? This cannot be undone.')) return;
      const button = e.currentTarget;
      button.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ action: 'clearLocalAttachments' });
        if (!response?.success) throw new Error(response?.error || 'Could not clear local images.');
      } catch (error) {
        showInfoModal('Could not clear local images', error.message);
      } finally {
        button.disabled = false;
      }
    });

    // Shortcut key recorder
    const shortcutBtn = settingsDropdown.querySelector('.vibe-shortcut-btn');
    let recording = false;
    shortcutBtn.addEventListener('click', () => {
      if (recording) {
        // Cancel recording
        cancelRecording();
        return;
      }
      recording = true;
      shortcutBtn.textContent = 'Press keys\u2026';
      shortcutBtn.classList.add('recording');

      function onKey(e) {
        // Ignore lone modifier keys — keep waiting for the actual key.
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

        // Reject hotkeys that would hijack typing (no modifier, or an editing
        // key) and cancel recording instead of swallowing the next keystroke,
        // so the user can try again. See hotkey.js for the exact rules.
        if (!isRecordableHotkey(e)) {
          cancelRecording();
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        const sc = {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey
        };

        customShortcut = sc;
        shortcutHint = formatShortcut(sc);
        shortcutBtn.textContent = shortcutHint;
        shortcutBtn.classList.remove('recording');
        recording = false;
        document.removeEventListener('keydown', onKey, true);
        activeRecordingCleanup = null;
        VibeAPI.saveCustomShortcut(sc);
      }

      function cancelRecording() {
        recording = false;
        shortcutBtn.textContent = shortcutHint;
        shortcutBtn.classList.remove('recording');
        document.removeEventListener('keydown', onKey, true);
        activeRecordingCleanup = null;
      }

      document.addEventListener('keydown', onKey, true);
      activeRecordingCleanup = () => document.removeEventListener('keydown', onKey, true);
    });

    // Badge color picker
    settingsDropdown.querySelectorAll('.vibe-color-dot').forEach(dot => {
      dot.addEventListener('click', async () => {
        badgeColor = dot.dataset.color;
        settingsDropdown.querySelectorAll('.vibe-color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        applyBadgeColor(badgeColor);
        await VibeAPI.saveBadgeColor(badgeColor);
      });
    });

    // Documentation
    settingsDropdown.querySelector('.vibe-get-started-btn').addEventListener('click', () => {
      showDocumentation();
    });

    // Import
    settingsDropdown.querySelector('.vibe-import-btn').addEventListener('click', () => {
      closeSettings();
      triggerImport();
    });

    // Prevent clicks inside dropdown from triggering outside-click close
    settingsDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Close on outside click (next tick to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', onOutsideClick);
    }, 0);
  }

  // Documentation/guide pages are in toolbar-docs.js (VibeToolbarDocs)
  const _docsCallbacks = {
    onBack: () => { closeSettings(); openSettings(); }
  };

  function showDocumentation() {
    VibeToolbarDocs.showDocumentation(settingsDropdown, ICONS, _docsCallbacks);
  }

  function closeSettings() {
    if (activeRecordingCleanup) { activeRecordingCleanup(); activeRecordingCleanup = null; }
    if (settingsDropdown) {
      settingsDropdown.remove();
      settingsDropdown = null;
    }
    const btn = toolbarEl?.querySelector('.vibe-tb-settings');
    if (btn) btn.classList.remove('active');
    document.removeEventListener('click', onOutsideClick);
  }

  function onOutsideClick(e) {
    if (settingsDropdown && !settingsDropdown.contains(e.target) && !e.target.closest('.vibe-tb-settings')) {
      closeSettings();
    }
  }

  function updateUI() {
    if (!toolbarEl) return;

    // Mode is synchronous. A delayed class swap can outlive Escape/disable and
    // leave the toolbar showing "annotating" after inspection has already stopped.
    toolbarEl.classList.toggle('annotating', isAnnotating);

    // --- Count pill on View all ---
    const totalCount = annotationCount + styleAnnotationCount;
    const pill = toolbarEl.querySelector('.vibe-toolbar-pill');
    if (pill) {
      if (totalCount > 0) {
        pill.textContent = totalCount;
        pill.style.display = '';
      } else {
        pill.style.display = 'none';
      }
    }

    // --- Send to Claude: only while the server and the Claude Code mod are up ---
    const sendEl = toolbarEl.querySelector('.vibe-tb-send');
    if (sendEl) {
      sendEl.style.display = serverOnline && claudeConnected ? '' : 'none';
      if (!sendEl.classList.contains('sending')) {
        sendEl.disabled = unsentCount === 0;
        sendEl.title = unsentCount > 0
          ? `Send ${unsentCount} annotation${unsentCount === 1 ? '' : 's'} to Claude Code`
          : inProgressIds.size > 0
            ? 'Claude is working on everything here'
            : 'Add annotations to send them to Claude Code';
        sendEl.setAttribute('aria-label', sendEl.title);
      }
    }

    // --- Status indicator (icon-only, label in tooltip) ---
    const statusEl = toolbarEl.querySelector('.vibe-tb-status');
    if (statusEl) {
      if (watcherActive) {
        statusEl.innerHTML = ICONS.eye;
        statusEl.style.color = 'var(--v-status-watching)';
        statusEl.title = 'Watching — click to stop';
      } else if (serverOnline && serverOutdated) {
        statusEl.innerHTML = ICONS.serverRack;
        statusEl.style.color = 'var(--v-status-watching)';
        statusEl.title = 'MCP Server online — update available (npm update -g vibe-annotations-server)';
      } else if (serverOnline) {
        statusEl.innerHTML = ICONS.serverRack;
        statusEl.style.color = 'var(--v-status-online)';
        statusEl.title = 'MCP Server online';
      } else {
        statusEl.innerHTML = ICONS.serverRack;
        statusEl.style.color = 'var(--v-status-offline)';
        statusEl.title = 'MCP Server offline';
      }
    }
  }

  async function refreshServerStatus(fresh = false) {
    const status = await VibeAPI.checkServerStatus({ fresh });
    const changed = serverOnline !== status.connected || serverOutdated !== !!status.outdated;
    serverOnline = status.connected;
    serverOutdated = !!status.outdated;
    if (changed) updateUI();
  }

  // --- Send to Claude ---

  let sessionPicker = null;

  async function sendToClaude(sessionId) {
    closeSessionPicker();
    const sendBtn = toolbarEl.querySelector('.vibe-tb-send');
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');
    let r = { success: false };
    try { r = await VibeAPI.sendToClaude(sessionId); } catch { /* server gone */ }
    if (r.choose) {
      sendBtn.classList.remove('sending');
      sendBtn.disabled = false;
      openSessionPicker(r.choose);
      return;
    }
    // Icon-only button: confirm with a check + a floating chip, so the bar keeps its width
    sendBtn.classList.add(r.success ? 'sent' : 'failed');
    sendBtn.innerHTML = r.success ? ICONS.check : ICONS.send;
    showSendChip(r.success ? `Sent to ${r.session.name}` : 'Claude not connected');
    // Show what was just sent in progress right away: the server only confirms
    // once the mod picked the send up (its next poll) and reported it back, so
    // re-check sooner than the 10s status poll until it does.
    if (r.success) {
      const sent = (await VibeAPI.loadProjectAnnotations()).filter(isSendable).map(a => a.id);
      justSent = { ids: new Set(sent), until: Date.now() + JUST_SENT_MS };
      applyProgress();
      await refreshUnsent();
      [2500, 5000, 9000, 15000, JUST_SENT_MS + 500].forEach(ms => setTimeout(refreshClaude, ms));
    }
    setTimeout(() => {
      sendBtn.classList.remove('sending', 'sent', 'failed');
      sendBtn.innerHTML = ICONS.send;
      if (!r.success) refreshClaude();
      updateUI();
    }, 1800);
  }

  function showSendChip(text) {
    toolbarEl.querySelector('.vibe-send-chip')?.remove();
    const rect = toolbarEl.getBoundingClientRect();
    const chip = document.createElement('div');
    chip.className = 'vibe-send-chip' + (rect.top > window.innerHeight / 2 ? ' above' : '');
    chip.textContent = text;
    toolbarEl.appendChild(chip);
    setTimeout(() => {
      chip.classList.add('out');
      setTimeout(() => chip.remove(), 200);
    }, 1800);
  }

  // Several Claude sessions are open and none works in this site's project:
  // ask which one. The server remembers the pick for this site.
  function openSessionPicker(sessions) {
    closeSettings();
    closeViewAll();
    const rect = toolbarEl.getBoundingClientRect();
    sessionPicker = document.createElement('div');
    sessionPicker.className = 'vibe-settings-dropdown' + (rect.top > window.innerHeight / 2 ? ' above' : '');
    sessionPicker.innerHTML = `
      <div class="vibe-settings-header"><span class="vibe-settings-title">Send to which Claude session?</span></div>
      <div class="vibe-settings-body">
        ${sessions.map(s => `<button class="vibe-settings-link" type="button" data-session="${escapeHTML(s.id)}">${ICONS.send}<span>${escapeHTML(s.name)}</span></button>`).join('')}
      </div>
    `;
    sessionPicker.addEventListener('click', (e) => {
      e.stopPropagation();
      const pick = e.target.closest('[data-session]');
      if (pick) sendToClaude(pick.dataset.session);
    });
    toolbarEl.appendChild(sessionPicker);
    setTimeout(() => document.addEventListener('click', closeSessionPicker), 0);
  }

  function closeSessionPicker() {
    if (sessionPicker) { sessionPicker.remove(); sessionPicker = null; }
    document.removeEventListener('click', closeSessionPicker);
  }

  // Send to Claude is for local dev sites only: on any other page skip the
  // check entirely, so the button never shows and the page never calls the server.
  async function refreshClaude() {
    const was = claudeConnected;
    const isLocal = VibeAPI.isLocalOrigin() && !VibeAPI.isFileProtocol();
    const status = isLocal && serverOnline ? await VibeAPI.getClaudeStatus() : { connected: false };
    claudeConnected = status.connected === true;
    serverProgressIds = new Set(claudeConnected && Array.isArray(status.inProgress) ? status.inProgress : []);
    const progressChanged = applyProgress();
    await refreshUnsent();
    if (was !== claudeConnected || progressChanged) updateUI();
  }

  // What Send would hand over: the same annotations the mod sends (pending
  // comments and design edits, not stylesheets or variants), minus those in progress.
  async function refreshUnsent() {
    const next = (await VibeAPI.loadProjectAnnotations()).filter(isSendable).length;
    if (next !== unsentCount) { unsentCount = next; updateUI(); }
  }

  function isSendable(a) {
    return a.status === 'pending' && a.type !== 'stylesheet' && a.mode !== 'variants' && !inProgressIds.has(a.id);
  }

  // Recompute what shows in progress; tell the badges and the list when it changed.
  function applyProgress() {
    const confirmed = [...justSent.ids].every(id => serverProgressIds.has(id));
    if (justSent.ids.size && (confirmed || Date.now() > justSent.until)) justSent = { ids: new Set(), until: 0 };
    const next = new Set([...serverProgressIds, ...justSent.ids]);
    const changed = next.size !== inProgressIds.size || [...next].some(id => !inProgressIds.has(id));
    if (!changed) return false;
    inProgressIds = next;
    VibeEvents.emit('claude:progress', { ids: [...next] });
    if (viewAllPanel) openViewAll();
    return true;
  }

  async function refreshWatchers() {
    refreshClaude();
    if (!serverOnline) {
      if (watcherActive) {
        watcherActive = false;
        updateUI();
        VibeEvents.emit('watch:changed', { active: false });
      }
      return;
    }
    const data = await VibeAPI.getWatchers();
    const wasActive = watcherActive;
    // Only show watch mode if a watcher matches the current page's origin
    const origin = window.location.origin; // e.g. "http://localhost:3001"
    watcherActive = (data.watchers || []).some(w => {
      const base = w.url.replace('*', '').replace(/\/$/, '');
      return origin.startsWith(base) || base.startsWith(origin);
    });
    if (wasActive !== watcherActive) {
      updateUI();
      VibeEvents.emit('watch:changed', { active: watcherActive });
    }
  }

  function animateToolbarOut() {
    if (!toolbarEl) return;
    closeSettings();
    closeViewAll();
    toolbarEl.classList.add('exiting');
    toolbarEl.addEventListener('animationend', () => {
      toolbarEl.classList.remove('exiting');
      VibeEvents.emit('overlay:closed');
      VibeShadowHost.hide();
    }, { once: true });
  }

  function animateToolbarIn() {
    if (!toolbarEl) return;
    // Reset animation by removing and re-adding
    toolbarEl.style.animation = 'none';
    requestAnimationFrame(() => {
      toolbarEl.style.animation = '';
    });
  }

  // --- Drag ---

  function setupDrag() {
    let isDragging = false;
    let didDrag = false;
    let startX, startY, startLeft, startTop;
    const DRAG_THRESHOLD = 4;

    toolbarEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.vibe-toolbar-btn') || e.target.closest('.vibe-toolbar-close') || e.target.closest('.vibe-toolbar-status') || e.target.closest('.vibe-toolbar-kbd')) return;

      isDragging = true;
      didDrag = false;
      toolbarEl.classList.add('dragging');
      const rect = toolbarEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!didDrag && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        didDrag = true;
      }

      const newRight = window.innerWidth - (startLeft + toolbarEl.offsetWidth) - dx;
      const newTop = startTop + dy;

      const clamped = clampPosition(newRight, newTop);

      toolbarEl.style.right = `${clamped.right}px`;
      toolbarEl.style.top = `${clamped.top}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      toolbarEl.classList.remove('dragging');

      if (didDrag) {
        VibeAPI.saveToolbarPosition({
          right: toolbarEl.style.right,
          top: toolbarEl.style.top
        });
      }
    });

    // Suppress clicks after drag on any toolbar button
    toolbarEl.addEventListener('click', (e) => {
      if (didDrag) {
        e.stopImmediatePropagation();
        didDrag = false;
      }
    }, true);
  }

  function isToolbarVisible() {
    if (!toolbarEl || !isOverlayVisible) return false;
    if (VibeShadowHost.getHost && VibeShadowHost.getHost()) {
      return VibeShadowHost.isVisible();
    }
    return true;
  }

  function handleWindowResize() {
    if (!isToolbarVisible()) return;
    clampCurrentPosition();
  }

  function clampPosition(rightPx, topPx) {
    const toolbarWidth = toolbarEl ? (toolbarEl.offsetWidth || 300) : 300;
    const toolbarHeight = toolbarEl ? (toolbarEl.offsetHeight || 40) : 40;
    const winWidth = window.innerWidth || document.documentElement?.clientWidth || 1024;
    const winHeight = window.innerHeight || document.documentElement?.clientHeight || 768;

    const maxRight = Math.max(8, winWidth - toolbarWidth - 8);
    const maxTop = Math.max(8, winHeight - toolbarHeight - 8);

    const clampedRight = Math.max(8, Math.min(rightPx, maxRight));
    const clampedTop = Math.max(8, Math.min(topPx, maxTop));

    return { right: clampedRight, top: clampedTop };
  }

  function clampCurrentPosition() {
    if (!toolbarEl) return;
    const currentRight = toolbarEl.style.right ? parseInt(toolbarEl.style.right, 10) : 24;
    const currentTop = toolbarEl.style.top ? parseInt(toolbarEl.style.top, 10) : 24;
    const validRight = Number.isFinite(currentRight) ? currentRight : 24;
    const validTop = Number.isFinite(currentTop) ? currentTop : 24;
    const clamped = clampPosition(validRight, validTop);

    if (clamped.right !== validRight) {
      toolbarEl.style.right = `${clamped.right}px`;
    }
    if (clamped.top !== validTop) {
      toolbarEl.style.top = `${clamped.top}px`;
    }
  }

  async function restorePosition() {
    const pos = await VibeAPI.getToolbarPosition();
    if (pos && toolbarEl) {
      const rightPx = parseInt(pos.right, 10);
      const topPx = parseInt(pos.top, 10);
      const validRight = Number.isFinite(rightPx) ? rightPx : 24;
      const validTop = Number.isFinite(topPx) ? topPx : 24;
      const clamped = clampPosition(validRight, validTop);
      toolbarEl.style.right = `${clamped.right}px`;
      toolbarEl.style.top = `${clamped.top}px`;
    } else if (toolbarEl) {
      clampCurrentPosition();
    }
  }

  // --- Delete confirm ---

  function showDeleteConfirm(root) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'vibe-confirm-backdrop';
      backdrop.innerHTML = `
        <div class="vibe-confirm">
          <div class="vibe-confirm-title">Delete all annotations?</div>
          <div class="vibe-confirm-msg">All annotations on this page will be permanently deleted.</div>
          <label class="vibe-confirm-skip" style="display:flex;align-items:center;gap:6px;margin:8px 0 4px;font-size:12px;color:var(--v-text-secondary,#6b7280);cursor:pointer;user-select:none;">
            <input type="checkbox" class="vibe-confirm-skip-cb" style="margin:0;">
            Don't ask again
          </label>
          <div class="vibe-confirm-actions">
            <button class="vibe-btn vibe-btn-secondary vibe-confirm-no">Cancel</button>
            <button class="vibe-btn vibe-btn-danger vibe-confirm-yes">Delete All</button>
          </div>
        </div>
      `;
      root.appendChild(backdrop);

      backdrop.querySelector('.vibe-confirm-no').addEventListener('click', () => { backdrop.remove(); resolve(false); });
      backdrop.querySelector('.vibe-confirm-yes').addEventListener('click', () => {
        const skipCb = backdrop.querySelector('.vibe-confirm-skip-cb');
        if (skipCb && skipCb.checked) {
          VibeAPI.saveSkipDeleteConfirm(true);
        }
        backdrop.remove();
        resolve(true);
      });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } });
    });
  }



  function triggerImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await processImport(data);
      } catch {
        showInfoModal('Invalid file', 'The selected file is not valid JSON.');
      }
    });

    input.click();
  }

  async function processImport(data) {
    const root = VibeShadowHost.getRoot();
    if (!root) return;

    // Validate envelope
    if (!data || data.vibe_annotations_export !== true || !Array.isArray(data.annotations)) {
      showInfoModal('Invalid format', 'This file is not an ng-vibe-remarker / Vibe Annotations export.');
      return;
    }

    // Validate origin match — offer remap if importing public URL annotations into localhost
    const currentOrigin = window.location.origin;
    let remapFrom = null;
    if (data.source?.origin && data.source.origin !== currentOrigin) {
      if (isLocalDev()) {
        const accepted = await showRemapConfirm(root, data.source.origin, currentOrigin);
        if (!accepted) return;
        remapFrom = data.source.origin;
      } else {
        showInfoModal(
          'Origin mismatch',
          `These annotations were exported from ${data.source.origin} but you are on ${currentOrigin}. Origins must match to import.`
        );
        return;
      }
    }

    // Remap URLs if importing from a different origin
    if (remapFrom) {
      for (const a of data.annotations) {
        if (a.url) a.url = a.url.replace(remapFrom, currentOrigin);
        if (a.url_path) { /* url_path is pathname-only, no origin to remap */ }
      }
    }

    // Deduplicate against existing
    const existing = await VibeAPI.loadProjectAnnotations();
    const existingIds = new Set(existing.map(a => a.id));
    const newAnnotations = data.annotations.filter(a => !existingIds.has(a.id));
    const skipped = data.annotations.length - newAnnotations.length;

    if (newAnnotations.length === 0) {
      showInfoModal('Nothing to import', `All ${data.annotations.length} annotation${data.annotations.length !== 1 ? 's' : ''} already exist locally.`);
      return;
    }

    // Confirm
    const confirmed = await showImportConfirm(root, {
      total: data.annotations.length,
      newCount: newAnnotations.length,
      skipped
    });
    if (!confirmed) return;

    // Import via background script (handles storage lock + server sync)
    await chrome.runtime.sendMessage({ action: 'importAnnotations', annotations: newAnnotations });
    // Storage listener in content.js handles re-render automatically
  }

  function showImportConfirm(root, { total, newCount, skipped }) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'vibe-confirm-backdrop';
      const skipText = skipped > 0 ? `<br>${skipped} already exist and will be skipped.` : '';
      backdrop.innerHTML = `
        <div class="vibe-confirm">
          <div class="vibe-confirm-title">Import annotations</div>
          <div class="vibe-confirm-msg">${newCount} annotation${newCount !== 1 ? 's' : ''} will be imported.${skipText}</div>
          <div class="vibe-confirm-actions">
            <button class="vibe-btn vibe-btn-secondary vibe-confirm-no">Cancel</button>
            <button class="vibe-btn vibe-btn-primary vibe-confirm-yes">Import</button>
          </div>
        </div>
      `;
      root.appendChild(backdrop);

      backdrop.querySelector('.vibe-confirm-no').addEventListener('click', () => { backdrop.remove(); resolve(false); });
      backdrop.querySelector('.vibe-confirm-yes').addEventListener('click', () => { backdrop.remove(); resolve(true); });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } });
    });
  }

  function isLocalDev() {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
      || h.endsWith('.local') || h.endsWith('.test') || h.endsWith('.localhost');
  }

  function showRemapConfirm(root, sourceOrigin, currentOrigin) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'vibe-confirm-backdrop';
      backdrop.innerHTML = `
        <div class="vibe-confirm">
          <div class="vibe-confirm-title">Remap annotations?</div>
          <div class="vibe-confirm-msg">
            These annotations were exported from <strong>${escapeHTML(sourceOrigin)}</strong>.
            Remap URLs to <strong>${escapeHTML(currentOrigin)}</strong> for local development?
          </div>
          <div style="font-size:12px;color:var(--v-text-secondary);margin-top:8px;margin-bottom:4px;line-height:1.5;">
            Important: Annotations might not perfectly anchor or apply the styling changes if the selectors aren't identical.
          </div>
          <div class="vibe-confirm-actions">
            <button class="vibe-btn vibe-btn-secondary vibe-confirm-no">Cancel</button>
            <button class="vibe-btn vibe-btn-primary vibe-confirm-yes">Remap & Import</button>
          </div>
        </div>
      `;
      root.appendChild(backdrop);

      backdrop.querySelector('.vibe-confirm-no').addEventListener('click', () => { backdrop.remove(); resolve(false); });
      backdrop.querySelector('.vibe-confirm-yes').addEventListener('click', () => { backdrop.remove(); resolve(true); });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } });
    });
  }

  function showInfoModal(title, message) {
    const root = VibeShadowHost.getRoot();
    if (!root) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'vibe-confirm-backdrop';
    backdrop.innerHTML = `
      <div class="vibe-confirm">
        <div class="vibe-confirm-title">${escapeHTML(title)}</div>
        <div class="vibe-confirm-msg">${escapeHTML(message)}</div>
        <div class="vibe-confirm-actions">
          <button class="vibe-btn vibe-btn-secondary vibe-confirm-no">OK</button>
        </div>
      </div>
    `;
    root.appendChild(backdrop);

    backdrop.querySelector('.vibe-confirm-no').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  }

  // --- Helpers ---

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Compact variant picker for a View all card: one radio row per variant, then
  // Choose / Update selection. On another route the rows show but stay disabled.
  function variantPickerHTML(a) {
    if (!isReviewable(a)) return '';
    const ctx = variantContext(a);
    if (!ctx.variants.length) return '';
    const current = currentVariant(ctx);
    const rows = ctx.variants.map(v => {
      const val = String(v.value);
      const on = val === current;
      return `<label class="vibe-variant-row compact${on ? ' active' : ''}">
        <input type="radio" name="vibe-variant-${escapeHTML(a.id)}" value="${escapeHTML(val)}"${on ? ' checked' : ''}${ctx.container ? '' : ' disabled'}>
        <span>${escapeHTML(v.name || val)}</span>
        ${ctx.chosen === val ? '<span class="vibe-variant-chosen-mark">Chosen</span>' : ''}
      </label>`;
    }).join('');
    const footer = ctx.container
      ? `<button type="button" class="vibe-btn vibe-btn-primary vibe-viewall-variant-choose">${chooseLabel(ctx.chosen, current)}</button>`
      : '<div class="vibe-viewall-variant-note">Open this page to preview and choose.</div>';
    return `<div class="vibe-viewall-variants" data-id="${escapeHTML(a.id)}">
      <div class="vibe-variant-list">${rows}</div>
      ${footer}
    </div>`;
  }

  function chooseLabel(chosen, selected) {
    if (chosen != null && chosen === selected) return 'Chosen ✓';
    return chosen != null ? 'Update selection' : 'Choose this variant';
  }

  function wireVariantPicker(box, a) {
    const ctx = variantContext(a);
    const chooseBtn = box.querySelector('.vibe-viewall-variant-choose');
    let chosen = ctx.chosen;
    const selected = () => box.querySelector('input[type="radio"]:checked')?.value ?? null;
    const refresh = () => {
      if (!chooseBtn) return;
      chooseBtn.textContent = chooseLabel(chosen, selected());
      chooseBtn.disabled = chosen != null && chosen === selected();
    };
    refresh();

    // Preview live and bring it into view: the badge may have lost its anchor
    // when a variant reshaped the page, but the variant itself is still there.
    box.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener('change', () => {
        previewVariant(a, ctx, input.value);
        box.querySelectorAll('.vibe-variant-row').forEach(r => r.classList.toggle('active', r.contains(input)));
        variantElement(ctx, input.value)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        refresh();
      });
    });

    chooseBtn?.addEventListener('click', async () => {
      const value = selected();
      if (value == null) return;
      try {
        await chooseVariant(a, value);
        chosen = value;
        refresh();
      } catch (err) { console.warn('[Vibe] choose variant failed:', err); }
    });
  }

  // Lifecycle chip for a variants annotation in a state that awaits agent action.
  // Returns null for normal annotations and for terminal 'resolved' (filtered out).
  function variantStatusLabel(a) {
    if (!a || a.mode !== 'variants') return null;
    switch (a.status) {
      case 'variants-ready': return { text: 'Variants ready — pick one below', cls: 'ready' };
      case 'variant-chosen': return { text: 'Chosen — awaiting agent finalize', cls: 'chosen' };
      case 'variants-discarded': return { text: 'Pending agent deletion', cls: 'discarded' };
      default: return null;
    }
  }

  function formatShortcut(sc) {
    const parts = [];
    if (sc.ctrlKey) parts.push(isMac ? '\u2303' : 'Ctrl');
    if (sc.metaKey) parts.push(isMac ? '\u2318' : 'Win');
    if (sc.altKey) parts.push(isMac ? '\u2325' : 'Alt');
    if (sc.shiftKey) parts.push(isMac ? '\u21E7' : 'Shift');
    // Friendly key name
    const keyMap = { ',': ',', '.': '.', '/': '/', ' ': 'Space', ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192' };
    const keyLabel = keyMap[sc.key] || (sc.key.length === 1 ? sc.key.toUpperCase() : sc.key);
    parts.push(keyLabel);
    return isMac ? parts.join('') : parts.join('+');
  }


  function formatAnnotationPath(annotation) {
    const ec = annotation.element_context || {};
    if (ec.path) return ec.path;

    const segments = [];
    if (annotation.parent_chain?.length) {
      annotation.parent_chain
        .slice()
        .reverse()
        .forEach(node => segments.push(formatPathNode(node)));
    }
    if (ec.tag) {
      segments.push(formatPathNode({
        tag: ec.tag,
        classes: ec.classes || [],
        id: ec.id || null,
        role: ec.role || null
      }));
    }

    if (!segments.length) return '';
    return segments.slice(-4).join(' > ');
  }

  function formatAnnotationSelector(annotation) {
    if (annotation.selector_preview) return annotation.selector_preview;

    const ec = annotation.element_context || {};
    const attrs = [];
    const classes = VibeElementContext.getDisplayClasses(ec.classes).slice(0, 6);
    if (classes.length) attrs.push(`class="${classes.join(' ')}"`);
    if (ec.id) attrs.push(`id="${ec.id}"`);
    if (ec.role) attrs.push(`role="${ec.role}"`);

    if (ec.tag) {
      return `<${ec.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    }

    return annotation.selector;
  }

  function formatPathNode(node) {
    const tag = node.tag || 'element';
    if (node.id) return `${tag}#${sanitizePathToken(node.id)}`;

    const classes = VibeElementContext.getDisplayClasses(node.classes).slice(0, 4);
    if (classes.length) {
      return `${tag}[class="${classes.map(c => sanitizePathToken(c, 48)).join(' ')}"]`;
    }

    if (node.role) return `${tag}[role="${sanitizePathToken(node.role)}"]`;
    return tag;
  }

  function sanitizePathToken(value, maxLen = 48) {
    return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  function applyBadgeColor(color) {
    const root = VibeShadowHost.getRoot();
    if (root) root.host.style.setProperty('--v-badge-bg', color);
  }

  function camelToKebab(str) {
    return str.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }

  function truncate(str, max) {
    const clean = str.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return clean.substring(0, max) + '\u2026';
  }

const VibeToolbar = { init, animateOut: animateToolbarOut };
export default VibeToolbar;
