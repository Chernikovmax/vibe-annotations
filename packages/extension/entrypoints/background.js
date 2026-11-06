// Vibe Annotations Background Service Worker — WXT entrypoint.
// Body is unchanged from the pre-WXT build; paths updated + wrapped in defineBackground().

import { isSupportedUrl, isLocalhostUrl } from '../lib/background/url-filter.js';
import { updateBadge, clearBadge, updateBadgeForUrl, updateAllBadges } from '../lib/background/badge.js';
import { isConnected, checkConnection, getCachedStatus, syncAll, saveOne, deleteOne, smartSync, fetchAnnotations, uploadAttachment, deleteAttachment, fetchExport, fetchWatchers, stopWatchers } from '../lib/background/api-sync.js';
import { formatExport } from '../lib/background/export.js';
import { migrateSyncFlags } from '../lib/background/utils.js';

import {
  bindLocalAttachments, cleanupExpiredDrafts, clearLocalAttachments,
  confirmLocalAttachmentsPublished, createLocalAttachment,
  discardLocalDraft as discardLocalDraftRecords, listLocalAttachments,
  readLocalAttachment, reconcileLocalAttachmentReferences, removeBoundLocalAttachmentIds,
  removeBoundLocalAttachments, removeLocalAttachment, unbindLocalAttachments,
} from '../lib/background/local-attachments.js';
function isRestrictedUrl(url) {
  if (!url) return true;
  return url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('view-source:');
}

async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content-scripts/content.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-scripts/bridge.js'],
    world: 'MAIN',
  });
}

async function seedBootIntent(tabId, intent, data) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (i, d) => { window.__VIBE_BOOT_INTENT = i; window.__VIBE_BOOT_DATA = d; },
    args: [intent, data],
  });
}

class VibeAnnotationsBackground {
  constructor() {
    this._storageQueue = Promise.resolve();
    this.init();
  }

  _withStorageLock(fn) {
    this._storageQueue = this._storageQueue.then(fn, fn);
    return this._storageQueue;
  }

  init() {
    this._localAttachmentRecovery = this._withStorageLock(async () => {
      await cleanupExpiredDrafts();
      await this.reconcileUnpublishedLocalAttachments();
      await cleanupExpiredDrafts();
    }).catch(error => console.error('Local attachment recovery failed:', error));
    this.setupInstallListener();
    this.setupMessageListener();
    this.setupTabListener();
    this.setupStorageListener();
    this.restoreEnabledSites();
    migrateSyncFlags();
    this.startConnectionMonitoring();
  }

  // --- Lifecycle ---

  setupInstallListener() {
    chrome.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') this.handleFirstInstall();
      else if (details.reason === 'update') this.handleUpdate(details.previousVersion);
    });
  }

  async handleFirstInstall() {
    return this._withStorageLock(async () => {
      try {
        // Unpacked reloads can emit "install" again with existing local data.
        // Initialization must never erase published annotations or image references.
        const existing = await chrome.storage.local.get(['annotations', 'settings']);
        const initial = {};
        if (!Array.isArray(existing.annotations)) initial.annotations = [];
        if (!existing.settings) initial.settings = { version: '0.1.0', firstInstall: Date.now(), apiEnabled: false };
        if (Object.keys(initial).length) await chrome.storage.local.set(initial);
      } catch (error) {
        console.error('Error setting up initial storage:', error);
      }
    });
  }

  async handleUpdate(previousVersion) {
    try {
      const currentVersion = chrome.runtime.getManifest().version;
      await chrome.storage.local.set({
        updateInfo: {
          hasUpdate: true, previousVersion, currentVersion,
          timestamp: Date.now(),
          releaseUrl: `https://github.com/RaphaelRegnier/vibe-annotations/releases/tag/v${currentVersion}`
        }
      });
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#D03D68' });

      const result = await chrome.storage.local.get(['settings']);
      const settings = result.settings || {};
      settings.lastUpdate = Date.now();
      settings.previousVersion = previousVersion;
      await chrome.storage.local.set({ settings });
    } catch (error) {
      console.error('Error during update migration:', error);
    }
  }

  async dismissUpdate() {
    const { updateInfo } = await chrome.storage.local.get(['updateInfo']);
    if (updateInfo) {
      await chrome.storage.local.set({
        updateInfo: { ...updateInfo, hasUpdate: false }
      });
    }
    chrome.action.setBadgeText({ text: '' });
  }

  // --- Message routing ---

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      switch (request.action) {
        case 'getAnnotations':
          fetchAnnotations(request.url)
            .then(annotations => sendResponse({ success: true, annotations }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'saveAnnotation':
          this.saveAnnotation(request.annotation, request.localDraftId)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'deleteAnnotation':
          this.deleteAnnotation(request.id)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'deleteAnnotationsByUrl':
          this.deleteAnnotationsByUrl(request.url)
            .then(({ count }) => sendResponse({ success: true, count }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'updateAnnotation':
          this.updateAnnotation(request.id, request.updates, request.localDraftId)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'captureLocalAttachment':
          this.captureLocalAttachment(request, sender)
            .then(attachment => sendResponse({ success: true, attachment }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'readLocalAttachment':
          this._localAttachmentRecovery.then(() => readLocalAttachment(request.id))
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'listLocalAttachments':
          this._localAttachmentRecovery.then(() => listLocalAttachments({ draftId: request.draftId, annotationId: request.annotationId }))
            .then(attachments => sendResponse({ success: true, attachments }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'removeLocalAttachment':
          this._localAttachmentRecovery.then(() => removeLocalAttachment(request.id, request.draftId))
            .then(removed => sendResponse({ success: true, removed }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'discardLocalDraft':
          this.discardLocalDraft(request.draftId)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'clearLocalAttachments':
          this.clearLocalAttachments()
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'recordAttachment':
          this.recordAttachment(request.id, request.att)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'uploadUserImage':
          this.uploadUserImage(request.id, request.mime, request.dataUrl, request.kind)
            .then(attachment => sendResponse({ success: true, attachment }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'removeAttachment':
          this.removeAttachment(request.id, request.attId)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'requestScreenshotPermission':
          this.requestScreenshotPermission()
            .then(granted => sendResponse({ success: true, granted }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'exportAnnotations':
          formatExport(request.format)
            .then(data => sendResponse({ success: true, data }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'checkMCPStatus': {
          // Serve the monitor's cached result unless the caller explicitly wants
          // a live probe (user gesture, tab regaining focus). Keeps idle pages
          // from generating any /health traffic at all — issue #84.
          const cached = request.fresh ? null : getCachedStatus();
          (cached ? Promise.resolve(cached) : checkConnection())
            .then(status => sendResponse({ success: true, status }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        }
        case 'fetchExport':
          fetchExport(request.urlPattern, request.format)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'getWatchers':
          fetchWatchers()
            .then(data => sendResponse({ success: true, ...data }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'stopWatchers':
          stopWatchers()
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'enableSite':
          this.enableSite(request.originPattern, request.tabId)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'requestSitePermission':
          this.requestSitePermission(request, sender)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'openPopupWithFocus':
          sendResponse({ success: true });
          break;
        case 'importAnnotations':
          this.importAnnotations(request.annotations)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'forceMCPSync':
          this.forceAPISync()
            .then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'dismissUpdate':
          this.dismissUpdate()
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;
        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
      return true;
    });
  }

  // --- Tab & storage listeners ---

  setupTabListener() {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (await isSupportedUrl(tab.url)) await updateBadge(tab.id, tab.url);
        else await clearBadge(tab.id);
      } catch (error) {
        console.error('Error updating badge on tab activation:', error);
      }
    });

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url) {
        if (await isSupportedUrl(tab.url)) await updateBadge(tabId, tab.url);
        else await clearBadge(tabId);
      }
    });
  }

  setupStorageListener() {
    chrome.storage.onChanged.addListener(async (changes, namespace) => {
      if (namespace === 'local' && changes.annotations) {
        try {
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (await isSupportedUrl(tab.url)) await updateBadge(tab.id, tab.url);
          }
        } catch (error) {
          console.error('Error updating badges after storage change:', error);
        }
      }
    });
  }

  // --- Storage CRUD ---

  async saveAnnotation(annotation, localDraftId) {
    return this._withStorageLock(async () => {
      const boundIds = [];
      try {
        const result = await chrome.storage.local.get(['annotations']);
        const annotations = result.annotations || [];
        const existing = annotations.find(a => a.id === annotation.id);
        const next = { ...annotation };
        const localIds = (next.attachments || []).filter(att => att?.local_only).map(att => att.id);
        if (localIds.length && !localDraftId) throw new Error('Local attachment draft id is required');
        if (localIds.length) {
          const bound = await bindLocalAttachments(localDraftId, next.id, localIds);
          boundIds.push(...bound.map(att => att.id));
          const byId = new Map(bound.map(att => [att.id, att]));
          next.attachments = next.attachments.map(att => att?.local_only ? byId.get(att.id) : att);
        }
        if (existing) annotations[annotations.indexOf(existing)] = next; else annotations.push(next);
        try {
          await chrome.storage.local.set({ annotations });
        } catch (error) {
          await this.removeUnpublishedBoundAttachments(next.id, boundIds);
          throw error;
        }
        await confirmLocalAttachmentsPublished(next.id, localIds);
        const retainedLocalIds = new Set(localIds);
        const obsoleteLocalIds = (existing?.attachments || [])
          .filter(att => att?.local_only && !retainedLocalIds.has(att.id))
          .map(att => att.id);
        await removeBoundLocalAttachmentIds(next.id, obsoleteLocalIds);
        saveOne(next).then(async () => {
          const fresh = await chrome.storage.local.get(['annotations']);
          const arr = fresh.annotations || [];
          const target = arr.find(a => a.id === next.id);
          if (target && !target._synced) {
            target._synced = true;
            await chrome.storage.local.set({ annotations: arr });
          }
        }).catch(() => {});
        updateBadgeForUrl(next.url).catch(() => {});
      } catch (error) {
        console.error('Error saving annotation:', error);
        throw error;
      }
    });
  }

  async deleteAnnotation(id) {
    return this._withStorageLock(async () => {
      try {
        const result = await chrome.storage.local.get(['annotations', 'deletedAnnotationIds']);
        const annotations = result.annotations || [];
        const target = annotations.find(a => a.id === id);

        // Protected delete: a variants annotation that has generated scaffolding is
        // NEVER hard-deleted from the client. Tombstoning it would make smartSync
        // fire a second server DELETE that hard-wipes it (once it's no longer
        // mid-cycle), destroying the agent's cleanup contract. Instead mark it
        // variants-discarded so it persists — surfaced to the agent for cleanup and
        // shown in "View all" as pending agent deletion — until the agent resolves it.
        if (target && target.mode === 'variants' && target.variantsPayload && target.status !== 'resolved') {
          if (target.status !== 'variants-discarded') {
            const updated = annotations.map(a => a.id === id
              ? { ...a, status: 'variants-discarded', updated_at: new Date().toISOString() }
              : a);
            await chrome.storage.local.set({ annotations: updated });
          }
          await updateBadgeForUrl(target.url);
          await updateAllBadges();
          return;
        }

        const deletedIds = result.deletedAnnotationIds || [];
        const filtered = annotations.filter(a => a.id !== id);
        if (!deletedIds.includes(id)) deletedIds.push(id);
        await chrome.storage.local.set({ annotations: filtered, deletedAnnotationIds: deletedIds });
        await removeBoundLocalAttachments(id, []);
        try { await deleteOne(id); } catch {}
        const deleted = annotations.find(a => a.id === id);
        if (deleted) await updateBadgeForUrl(deleted.url);
        await updateAllBadges();
      } catch (error) {
        console.error('Error deleting annotation:', error);
        throw error;
      }
    });
  }

  async deleteAnnotationsByUrl(url) {
    return this._withStorageLock(async () => {
      const result = await chrome.storage.local.get(['annotations', 'deletedAnnotationIds']);
      const all = result.annotations || [];
      const deletedIds = result.deletedAnnotationIds || [];
      const toDelete = all.filter(a => a.url === url);
      const remaining = all.filter(a => a.url !== url);
      for (const a of toDelete) { if (!deletedIds.includes(a.id)) deletedIds.push(a.id); }
      await chrome.storage.local.set({ annotations: remaining, deletedAnnotationIds: deletedIds });
      await Promise.all(toDelete.map(annotation => removeBoundLocalAttachments(annotation.id, [])));
      for (const a of toDelete) deleteOne(a.id).catch(() => {});
      await updateBadgeForUrl(url);
      await updateAllBadges();
      return { count: toDelete.length };
    });
  }

  async updateAnnotation(id, updates, localDraftId) {
    return this._withStorageLock(async () => {
      const newlyBoundIds = [];
      try {
        const result = await chrome.storage.local.get(['annotations']);
        const annotations = result.annotations || [];
        const idx = annotations.findIndex(a => a.id === id);
        if (idx === -1) throw new Error('Annotation not found');
        const current = annotations[idx];
        const next = { ...current, ...updates, updated_at: new Date().toISOString() };
        const localIds = (next.attachments || []).filter(att => att?.local_only).map(att => att.id);
        const existingLocalIds = new Set((current.attachments || []).filter(att => att?.local_only).map(att => att.id));
        const toBind = localIds.filter(attId => !existingLocalIds.has(attId));
        if (toBind.length && !localDraftId) throw new Error('Local attachment draft id is required');
        if (toBind.length) {
          const bound = await bindLocalAttachments(localDraftId, id, toBind);
          newlyBoundIds.push(...bound.map(att => att.id));
          const byId = new Map(bound.map(att => [att.id, att]));
          next.attachments = next.attachments.map(att => att?.local_only && byId.has(att.id) ? byId.get(att.id) : att);
        }
        annotations[idx] = next;
        try {
          await chrome.storage.local.set({ annotations });
        } catch (error) {
          await this.removeUnpublishedBoundAttachments(id, newlyBoundIds);
          throw error;
        }
        const keepIds = (next.attachments || []).filter(att => att?.local_only).map(att => att.id);
        await confirmLocalAttachmentsPublished(id, keepIds);
        await removeBoundLocalAttachments(id, keepIds);
        updateBadgeForUrl(next.url).catch(() => {});
      } catch (error) {
        console.error('Error updating annotation:', error);
        throw error;
      }
    });
  }

  async reconcileUnpublishedLocalAttachments() {
    const { annotations = [] } = await chrome.storage.local.get(['annotations']);
    const referenced = new Set();
    for (const annotation of annotations) {
      for (const attachment of annotation.attachments || []) {
        if (attachment?.local_only) referenced.add(attachment.id);
      }
    }
    await reconcileLocalAttachmentReferences(referenced);
  }
  async removeUnpublishedBoundAttachments(annotationId, candidateIds) {
    if (!candidateIds.length) return;
    const { annotations = [] } = await chrome.storage.local.get(['annotations']);
    const referenced = new Set();
    for (const annotation of annotations) {
      for (const attachment of annotation.attachments || []) {
        if (attachment?.local_only) referenced.add(attachment.id);
      }
    }
    const removable = candidateIds.filter(id => !referenced.has(id));
    await unbindLocalAttachments(annotationId, removable);
  }

  async captureLocalAttachment(request, sender) {
    const tabId = sender?.tab?.id;
    const windowId = sender?.tab?.windowId;
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) throw new Error('Capture must originate from an active browser tab');
    if (!['element', 'region'].includes(request.captureMode)) throw new Error('Capture mode must be element or region');
    await this._localAttachmentRecovery;

    const watchKey = `__vaCaptureGeometry_${crypto.randomUUID().replaceAll('-', '')}`;
    const readGeometry = async (watch = false) => {
      const [entry] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (key, install) => {
          const visual = window.visualViewport;
          const geometry = () => ({
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
          });
          if (install) {
            const watch = { changed: false };
            const changed = event => {
              if (event.target === window || event.target === document || event.target === document.documentElement ||
                  event.target === document.body || event.target === visual) watch.changed = true;
            };
            window.addEventListener('scroll', changed, true);
            window.addEventListener('resize', changed, true);
            visual?.addEventListener('scroll', changed);
            visual?.addEventListener('resize', changed);
            window[key] = { watch, changed, visual };
          }
          const current = window[key];
          return { geometry: geometry(), changed: !!current?.watch.changed };
        },
        args: [watchKey, watch],
      });
      return entry?.result;
    };
    const stopGeometryWatch = async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: key => {
            const current = window[key];
            if (!current) return;
            window.removeEventListener('scroll', current.changed, true);
            window.removeEventListener('resize', current.changed, true);
            current.visual?.removeEventListener('scroll', current.changed);
            current.visual?.removeEventListener('resize', current.changed);
            delete window[key];
          },
          args: [watchKey],
        });
      } catch { /* The tab may have navigated or closed during cancellation. */ }
    };
    const sameGeometry = (a, b) => a && b && Object.keys(a).every(key =>
      Number.isFinite(a[key]) && Number.isFinite(b[key]) && Math.abs(a[key] - b[key]) < 0.01);
    let contextChanged = false;
    const onActivated = info => { if (info.windowId === windowId && info.tabId !== tabId) contextChanged = true; };
    const onFocusChanged = focusedWindowId => { if (focusedWindowId !== windowId) contextChanged = true; };
    const onTabUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && (changeInfo.status === 'loading' || changeInfo.url)) contextChanged = true;
    };
    const onTabRemoved = removedTabId => { if (removedTabId === tabId) contextChanged = true; };
    const onZoomChanged = info => { if (info.tabId === tabId) contextChanged = true; };
    const assertCaptureContext = async (expectedGeometry, expectedZoom) => {
      const [focusedWindow, activeTabs, currentZoom, geometryResult] = await Promise.all([
        chrome.windows.getLastFocused(),
        chrome.tabs.query({ active: true, windowId }),
        chrome.tabs.getZoom(tabId),
        readGeometry(),
      ]);
      if (contextChanged || focusedWindow.id !== windowId || focusedWindow.focused === false ||
          !activeTabs.some(tab => tab.id === tabId)) {
        throw new Error('Capture cancelled because the active tab or focused window changed.');
      }
      if (geometryResult?.changed) throw new Error('Capture cancelled because the page viewport or scroll position changed.');
      if (expectedZoom != null && Math.abs(currentZoom - expectedZoom) > 0.001) {
        throw new Error('Capture cancelled because browser zoom changed.');
      }
      if (expectedGeometry && !sameGeometry(expectedGeometry, geometryResult?.geometry)) {
        throw new Error('Capture cancelled because the page viewport, scroll position, or zoom changed.');
      }
      return { zoom: currentZoom, geometry: geometryResult.geometry };
    };

    const crop = request.crop || {};
    const viewport = crop.viewport;
    const visualWidth = viewport?.visualWidth || viewport?.width;
    const visualHeight = viewport?.visualHeight || viewport?.height;
    if (!viewport || ![crop.left, crop.top, crop.width, crop.height, viewport.width, viewport.height,
      visualWidth, visualHeight, viewport.visualOffsetLeft ?? 0, viewport.visualOffsetTop ?? 0]
      .every(Number.isFinite) || crop.width <= 0 || crop.height <= 0 || viewport.width <= 0 ||
      viewport.height <= 0 || visualWidth <= 0 || visualHeight <= 0) {
      throw new Error('Capture crop has invalid viewport geometry');
    }
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.tabs.onZoomChange.addListener(onZoomChanged);
    try {
      await readGeometry(true);
    const before = await assertCaptureContext(viewport);
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    await assertCaptureContext(before.geometry, before.zoom);

    const fullBlob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(fullBlob);
    try {
      // captureVisibleTab includes scrollbar gutters; visualViewport excludes them.
      // Its scale/offset describe pinch zoom, while innerWidth/Height span the bitmap.
      const visualWidth = viewport.width / (viewport.visualScale || 1);
      const visualHeight = viewport.height / (viewport.visualScale || 1);
      const offsetLeft = viewport.visualOffsetLeft || 0;
      const offsetTop = viewport.visualOffsetTop || 0;
      if (Math.abs(bitmap.width * visualHeight / visualWidth - bitmap.height) > 2) {
        throw new Error(`Capture cancelled because bitmap ${bitmap.width}×${bitmap.height} and viewport ${visualWidth}×${visualHeight} geometry do not match.`);
      }
      const left = Math.max(0, Math.min(bitmap.width, Math.floor((crop.left - offsetLeft) * bitmap.width / visualWidth)));
      const top = Math.max(0, Math.min(bitmap.height, Math.floor((crop.top - offsetTop) * bitmap.height / visualHeight)));
      const right = Math.max(left, Math.min(bitmap.width, Math.ceil((crop.left + crop.width - offsetLeft) * bitmap.width / visualWidth)));
      const bottom = Math.max(top, Math.min(bitmap.height, Math.ceil((crop.top + crop.height - offsetTop) * bitmap.height / visualHeight)));
      const sx = left, sy = top, sw = right - left, sh = bottom - top;
      if (sw <= 0 || sh <= 0) throw new Error('Capture crop is outside the captured image');
      const cropped = await createImageBitmap(bitmap, sx, sy, sw, sh);
      try {
        const canvas = new OffscreenCanvas(cropped.width, cropped.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to create capture canvas');
        context.drawImage(cropped, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
        if (blob.type !== 'image/webp') throw new Error('Unable to encode capture as WebP');
        await assertCaptureContext(before.geometry, before.zoom);
        const attachment = await createLocalAttachment({
          draft_id: request.draftId,
          capture_mode: request.captureMode,
          mime: blob.type,
          width: cropped.width,
          height: cropped.height,
          blob,
        });
        try {
          await assertCaptureContext(before.geometry, before.zoom);
        } catch (error) {
          await removeLocalAttachment(attachment.id, request.draftId);
          throw error;
        }
        return attachment;
      } finally {
        cropped.close?.();
      }
    } finally {
      bitmap.close?.();
    }
    } finally {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
      chrome.tabs.onZoomChange.removeListener(onZoomChanged);
      await stopGeometryWatch();
    }
  }

  async discardLocalDraft(draftId) {
    return this._withStorageLock(async () => {
      const items = await listLocalAttachments({ draftId });
      const { annotations = [] } = await chrome.storage.local.get(['annotations']);
      const referenced = new Set();
      for (const annotation of annotations) {
        for (const attachment of annotation.attachments || []) {
          if (attachment?.local_only) referenced.add(attachment.id);
        }
      }
      let removed = 0;
      for (const item of items) {
        if (item.annotation_id && !referenced.has(item.id)) {
          removed += await removeBoundLocalAttachmentIds(item.annotation_id, [item.id]);
        }
      }
      const unbound = await discardLocalDraftRecords(draftId);
      return { removed: removed + unbound.removed };
    });
  }
  async clearLocalAttachments() {
    return this._withStorageLock(async () => {
      const { annotations = [] } = await chrome.storage.local.get(['annotations']);
      const cleaned = annotations.map(annotation => ({
        ...annotation,
        attachments: (annotation.attachments || []).filter(att => !att?.local_only),
      }));
      await chrome.storage.local.set({ annotations: cleaned });
      return clearLocalAttachments();
    });
  }


  // Mirror an attachment's metadata into chrome.storage so the extension UI can
  // render it without waiting for the next server pull. The file already lives on
  // the server; this only tracks { id, kind, mime }. Capture replaces any prior
  // capture (mirrors the server); user attachments append (dedup by id).
  async recordAttachment(id, att) {
    if (!att) return;
    return this._withStorageLock(async () => {
      const { annotations = [] } = await chrome.storage.local.get(['annotations']);
      const idx = annotations.findIndex(a => a.id === id);
      if (idx === -1) return;
      const cur = Array.isArray(annotations[idx].attachments) ? annotations[idx].attachments : [];
      const next = att.kind === 'capture'
        ? [att, ...cur.filter(a => a.kind !== 'capture' || a.local_only)]
        : [...cur.filter(a => a.id !== att.id), att];
      annotations[idx] = { ...annotations[idx], attachments: next };
      await chrome.storage.local.set({ annotations });
    });
  }

  // Upload a user image whose bytes arrived as a data URL (non-local origins that
  // can't POST to localhost directly). Decode → upload → mirror into storage.
  async uploadUserImage(id, mime, dataUrl, kind = 'user') {
    const blob = await (await fetch(dataUrl)).blob();
    const { attachment } = await uploadAttachment(id, blob, kind, mime);
    if (attachment) await this.recordAttachment(id, attachment);
    return attachment;
  }

  // Request screenshot host permission in response to the explicit capture action.
  // Already-granted permission returns true without a prompt.
  async requestScreenshotPermission() {
    try {
      // Content UI clicks do not themselves grant activeTab. Request the existing
      // optional all-sites permission rather than broadening mandatory permissions.
      return await chrome.permissions.request({ origins: ['<all_urls>'] });
    } catch (err) {
      console.error('Screenshot permission request failed:', err);
      return false;
    }
  }

  // Remove an attachment: unlink the file server-side, drop the metadata locally.
  async removeAttachment(id, attId) {
    try { await deleteAttachment(id, attId); } catch (error) { console.warn('Attachment delete failed on server:', error.message); }
    return this._withStorageLock(async () => {
      const { annotations = [] } = await chrome.storage.local.get(['annotations']);
      const idx = annotations.findIndex(a => a.id === id);
      if (idx === -1) return;
      const cur = Array.isArray(annotations[idx].attachments) ? annotations[idx].attachments : [];
      annotations[idx] = { ...annotations[idx], attachments: cur.filter(a => a.id !== attId) };
      await chrome.storage.local.set({ annotations });
    });
  }

  async importAnnotations(newAnnotations) {
    if (!Array.isArray(newAnnotations) || !newAnnotations.length) return { imported: 0 };
    return this._withStorageLock(async () => {
      const result = await chrome.storage.local.get(['annotations', 'deletedAnnotationIds']);
      const all = result.annotations || [];
      const deletedIds = result.deletedAnnotationIds || [];
      const existingIds = new Set(all.map(a => a.id));
      let imported = 0;
      const importedIds = [];
      for (const a of newAnnotations) {
        if (!existingIds.has(a.id)) { all.push(a); existingIds.add(a.id); importedIds.push(a.id); imported++; }
      }
      if (imported > 0) {
        const cleanedTombstones = deletedIds.filter(id => !importedIds.includes(id));
        await chrome.storage.local.set({ annotations: all, deletedAnnotationIds: cleanedTombstones });
        try {
          await syncAll(all);
          let flagsChanged = false;
          for (const a of all) { if (!a._synced) { a._synced = true; flagsChanged = true; } }
          if (flagsChanged) await chrome.storage.local.set({ annotations: all });
        } catch (e) { console.warn('Failed to sync imported annotations to server:', e.message); }
        await updateAllBadges();
      }
      return { imported, total: all.length };
    });
  }

  async forceAPISync() {
    try {
      const result = await chrome.storage.local.get(['annotations']);
      const annotations = result.annotations || [];
      await syncAll(annotations);
      return { count: annotations.length, message: `Synced ${annotations.length} annotations to API server` };
    } catch (error) {
      console.error('Error in forced API sync:', error);
      throw error;
    }
  }

  // --- Connection monitoring ---

  startConnectionMonitoring() {
    const MIN_DELAY = 10000;
    const MAX_DELAY = 60000;
    let delay = MIN_DELAY;
    const tick = async () => {
      const wasConnected = isConnected();
      await checkConnection();
      if (wasConnected !== isConnected()) await updateAllBadges();
      if (isConnected()) {
        delay = MIN_DELAY;
        await smartSync(fn => this._withStorageLock(fn));
      } else {
        // Back off while the server is down instead of polling a dead port every 10s (issue #84).
        delay = Math.min(delay * 2, MAX_DELAY);
      }
      setTimeout(tick, delay);
    };
    checkConnection().then(() => updateAllBadges()).finally(() => setTimeout(tick, delay));
  }

  // --- Content script registration ---

  async restoreEnabledSites() {
    try {
      const result = await chrome.storage.local.get(['vibeEnabledSites']);
      const sites = result.vibeEnabledSites || [];
      for (const originPattern of sites) {
        const has = await chrome.permissions.contains({ origins: [originPattern] });
        if (has) await this.enableSite(originPattern, null);
      }
    } catch (err) {
      console.error('Error restoring enabled sites:', err);
    }
  }

  // Called from the permission modal in the content script. Must run while the user gesture
  // from the modal click is still valid for chrome.permissions.request (MV3 propagates the
  // gesture through sendMessage → onMessage).
  async requestSitePermission({ originPattern, allSites }, sender) {
    const target = allSites ? { origins: ['*://*/*'] } : { origins: [originPattern] };
    let granted = false;
    try {
      granted = await chrome.permissions.request(target);
    } catch (err) {
      console.error('Permission request failed:', err);
      return { granted: false, error: err.message };
    }
    if (!granted) return { granted: false };

    const { vibeEnabledSites = [] } = await chrome.storage.local.get(['vibeEnabledSites']);
    if (!vibeEnabledSites.includes(originPattern)) {
      vibeEnabledSites.push(originPattern);
      await chrome.storage.local.set({ vibeEnabledSites });
    }
    // tabId=null so enableSite skips chrome.tabs.reload — the already-injected content
    // script boots in place via bootNormal() once it sees our grant response.
    await this.enableSite(originPattern, null);
    return { granted: true };
  }

  async enableSite(originPattern, tabId) {
    // WXT bundles each entrypoint into a single file under content-scripts/.
    // Entrypoint `content/index.js` → `content-scripts/content.js`.
    // Entrypoint `bridge.content.js` → `content-scripts/bridge.js`.
    const scriptId = 'vibe-' + originPattern.replace(/[^a-zA-Z0-9]/g, '_');
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] }).catch(() => {});
      await chrome.scripting.registerContentScripts([{
        id: scriptId, matches: [originPattern],
        js: ['content-scripts/content.js'],
        runAt: 'document_idle', persistAcrossSessions: true
      }]);
      const bridgeScriptId = scriptId + '_bridge';
      await chrome.scripting.unregisterContentScripts({ ids: [bridgeScriptId] }).catch(() => {});
      await chrome.scripting.registerContentScripts([{
        id: bridgeScriptId, matches: [originPattern],
        js: ['content-scripts/bridge.js'], world: 'MAIN', runAt: 'document_start', persistAcrossSessions: true
      }]);
    } catch (err) {
      console.error('Failed to register content scripts:', err);
    }
    if (tabId) await chrome.tabs.reload(tabId);
  }
}

export default defineBackground(() => {
  // Instantiate the existing class — no behavior change, just wrapped for WXT.
  const bg = new VibeAnnotationsBackground();

  // Keyboard shortcut commands. Optional-chained: chrome.commands is a Chrome-only
  // capability, undefined in embedded Chromium hosts (Electron, WebView2, CEF) — an
  // unguarded call throws here and aborts the rest of worker init.
  chrome.commands?.onCommand?.addListener?.(async (command, tab) => {
    if (command === 'toggle-annotate' && tab?.id && (await isSupportedUrl(tab.url))) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggleAnnotate' });
      } catch {
        /* Content script not loaded */
      }
    }
  });

  // Icon click — no popup.html anymore. The whole flow lives in the content-script overlay:
  // localhost/granted pages toggle the existing toolbar; unsupported pages get a permission
  // modal inside the shadow host.
  // Optional-chained for the same reason as chrome.commands above — embedded hosts have
  // no extension toolbar icon, so chrome.action may be absent and this event never fires.
  chrome.action?.onClicked?.addListener?.(async (tab) => {
    if (!tab?.id || !tab?.url || isRestrictedUrl(tab.url)) return;

    let originPattern, hostname;
    try {
      const u = new URL(tab.url);
      originPattern = `${u.protocol}//${u.host}/*`;
      hostname = u.hostname;
    } catch {
      return;
    }

    const localhost = isLocalhostUrl(tab.url);
    const hasSpecific = await chrome.permissions.contains({ origins: [originPattern] });
    const hasAll = !localhost && !hasSpecific && await chrome.permissions.contains({ origins: ['*://*/*'] });
    const granted = localhost || hasSpecific || hasAll;

    if (granted) {
      // Supported — toggle the overlay. If content scripts haven't loaded (SW restart,
      // freshly-granted non-localhost), inject them now and retry.
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggleOverlay' });
      } catch {
        try {
          await injectContentScripts(tab.id);
          await chrome.tabs.sendMessage(tab.id, { action: 'toggleOverlay' }).catch(() => {});
        } catch (err) {
          console.error('Failed to inject content scripts:', err);
        }
      }
      // Persist registration for non-localhost so future loads auto-inject.
      if (!localhost) bg.enableSite(originPattern, null).catch(() => {});
    } else {
      // Unsupported — seed a boot intent then inject. content/index.js reads the intent and
      // shows the permission modal instead of booting the toolbar.
      try {
        await seedBootIntent(tab.id, 'show-permission-prompt', { originPattern, hostname });
        await injectContentScripts(tab.id);
      } catch (err) {
        console.error('Failed to open permission prompt:', err);
      }
    }
  });
});
