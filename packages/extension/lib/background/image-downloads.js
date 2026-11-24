import { readLocalAttachment } from './local-attachments.js';

const STORAGE_KEY = 'vibeImageDownloads';
const ALARM = 'vibe-image-download-cleanup';
const TTL_MS = 48 * 60 * 60 * 1000;
let queue = Promise.resolve();
function serialized(fn) {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

function completedDownload(id) {
  return new Promise((resolve, reject) => {
    const finish = (error, item) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(changed);
      if (error) reject(error); else resolve(item);
    };
    const check = async () => {
      try {
        const [item] = await chrome.downloads.search({ id });
        if (!item || item.state === 'interrupted') finish(new Error('Image download was cancelled or interrupted'));
        else if (item.state === 'complete') finish(null, item);
      } catch (error) { finish(error); }
    };
    const changed = delta => { if (delta.id === id) check(); };
    const timer = setTimeout(() => finish(new Error('Image download did not finish in time')), 60000);
    chrome.downloads.onChanged.addListener(changed);
    check(); // Covers a small image completing before the listener was installed.
  });
}

export function exportLocalImages(images, sender) {
  return serialized(async () => {
    const { annotations = [] } = await chrome.storage.local.get('annotations');
    // Validate the whole selection before starting any downloads.
    const selected = images.map(({ annotationId, attachmentId }) => {
      const annotation = annotations.find(a => a.id === annotationId);
      const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
      if (!extensionPage && new URL(annotation?.url).origin !== new URL(sender.url).origin) throw new Error('Image belongs to another site');
      const attachment = annotation?.attachments?.find(a => a.id === attachmentId && a.local_only);
      if (!attachment) throw new Error('Selected local image is unavailable; exclude it or restore its data');
      return { annotationId, attachmentId, kind: attachment.kind };
    });
    const { [STORAGE_KEY]: records = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const results = [];
    for (const image of selected) {
      let data;
      try { data = await readLocalAttachment(image.attachmentId); }
      catch (error) { throw new Error(`Selected local image is unavailable: ${error.message}. Exclude it or restore its data.`); }
      const extensions = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
      const ext = extensions[data.attachment.mime];
      if (!ext) throw new Error('Unsupported local image format');
      const id = await chrome.downloads.download({
        url: data.dataUrl,
        filename: `Remarker/${crypto.randomUUID()}.${ext}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      const record = { id, expiresAt: Date.now() + TTL_MS };
      records.push(record);
      // Persist before waiting: an interrupted export must still have a cleanup owner.
      try { await chrome.storage.local.set({ [STORAGE_KEY]: records }); }
      catch (error) {
        await chrome.downloads.cancel(id).catch(() => {});
        await chrome.downloads.removeFile(id).catch(() => {});
        throw error;
      }
      let item;
      try { item = await completedDownload(id); }
      catch (error) { await chrome.downloads.cancel(id).catch(() => {}); throw error; }
      if (!item.filename) throw new Error('Chrome did not provide the downloaded image path');
      record.path = item.filename;
      record.expiresAt = Date.now() + TTL_MS;
      await chrome.storage.local.set({ [STORAGE_KEY]: records });
      results.push({ ...image, path: item.filename, expiresAt: new Date(record.expiresAt).toISOString() });
    }
    return results;
  });
}

function cleanupDownloads() {
  return serialized(async () => {
    const { [STORAGE_KEY]: records = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const retained = [];
    for (const record of records) {
      if (record.expiresAt > Date.now()) { retained.push(record); continue; }
      try {
        const [item] = await chrome.downloads.search({ id: record.id });
        // Never delete a different download or a file retargeted since export.
        if (!item || item.byExtensionId !== chrome.runtime.id || (record.path && item.filename !== record.path)) continue;
        if (item.state === 'in_progress') {
          await chrome.downloads.cancel(record.id);
          retained.push(record);
        } else if (item.state === 'complete' && item.exists !== false) {
          await chrome.downloads.removeFile(record.id);
        }
      } catch (error) {
        retained.push(record);
        console.error('Exported image cleanup failed:', error);
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: retained });
  });
}

export function initImageDownloads() {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) cleanupDownloads().catch(console.error);
  });
  // MV3 alarms may be lost on restart/update. Recreate only when absent.
  (async () => {
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 60 });
    await cleanupDownloads();
  })().catch(console.error);
}
