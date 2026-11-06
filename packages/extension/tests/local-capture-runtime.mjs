// Browser-boundary regression: real extension capture, IDB commit, editing and restart.
// No MCP server or real user profile. Set ANGULAR_DEPS to the existing isolated Playwright installation.
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const require = createRequire(join(process.env.ANGULAR_DEPS || '/tmp/va-stage1-ng20', 'package.json'));
const { chromium } = require('playwright');
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'va-local-capture-'));
const { build } = require('esbuild');
const server = createServer((_req, res) => res.end(`<!doctype html><style>body{margin:40px;background:#eef}button{margin:20px}button#target{width:180px;height:90px;background:#f80}</style><button id="text-target">Text target</button><button id="target">Local capture target</button><button id="draft-target">Draft target</button>`));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, worker, page;
const pageErrors = [];
const unpacked = join(extension, '.output/chrome-mv3');
const launch = async () => {
  browser = await chromium.launchPersistentContext(profile, { headless: !process.env.HEADED, channel: 'chromium', args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
  worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    const nativeFetch = globalThis.fetch;
    globalThis.httpAttempts = [];
    globalThis.fetch = (url, ...args) => {
      if (/^https?:/.test(String(url))) { httpAttempts.push(String(url)); return Promise.reject(new Error('Offline capture fixture')); }
      return nativeFetch(url, ...args);
    };
  });
  page = await browser.newPage();
  if (process.env.HEADED) page.setDefaultTimeout(120000);
  page.on('pageerror', error => { pageErrors.push(error.stack); console.error('PAGE ERROR', error.stack); });
  await page.goto(origin);
  await page.waitForFunction(() => window.__vibeAnnotations);
};
const rows = () => worker.evaluate(async () => (await chrome.storage.local.get('annotations')).annotations || []);
const openNew = async (selector = '#target') => {
  const annotate = page.locator('.vibe-tb-annotate');
  if (await annotate.isVisible()) await annotate.click();
  await page.locator(selector).click();
  await page.locator('.vibe-textarea').waitFor();
};
const capture = async (mode = 'shot') => {
  // Respect Chrome's captureVisibleTab rate limit; this is not application retry logic.
  await page.waitForTimeout(600);
  await page.locator('.vibe-add-btn').click();
  await page.locator(`[data-add="${mode}"]`).click();
  if (mode === 'region') {
    await page.locator('.vibe-region-shade').waitFor();
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.move(450, 400, { steps: 4 });
    await page.mouse.up();
  }
  await page.waitForFunction(() => {
    const host = [...document.querySelectorAll('*')].find(el => el.shadowRoot?.querySelector('.vibe-attachment-status'));
    const status = host?.shadowRoot.querySelector('.vibe-attachment-status')?.textContent || '';
    return status.includes('Saved locally') || (status && !status.includes('Waiting') && !status.includes('Capturing'));
  });
  await page.locator('.vibe-att-img').last().waitFor();
  // The inherited region prototype swallows ALL trailing clicks for 400ms.
  // Stage 4 replaces that guard; this storage test does not claim gesture isolation.
  if (mode === 'region') await page.waitForTimeout(600);
};
try {
  await launch();
  await worker.evaluate(async () => {
    const capture = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    globalThis.captureCalls = 0;
    chrome.tabs.captureVisibleTab = (...args) => { captureCalls++; return capture(...args); };
    await chrome.storage.local.set({ screenshotEnabled: true });
  });
  await openNew('#text-target');
  assert.equal(await page.locator('.vibe-save-btn').isDisabled(), true, 'auto setting cannot make an empty annotation valid');
  await page.locator('.vibe-textarea').fill('Text without automatic capture');
  await page.locator('.vibe-save-btn').click();
  await page.locator('.vibe-popover').waitFor({ state: 'detached' });
  assert.equal((await rows()).find(a => a.comment.startsWith('Text without')).attachments.length, 0);
  assert.equal(await worker.evaluate(() => captureCalls), 0);
  console.log('PASS no automatic capture with legacy ON setting');
  await openNew();
  await worker.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    let failNext = true;
    IDBObjectStore.prototype.add = function (...args) {
      if (failNext && this.name === 'attachments') {
        failNext = false;
        throw new DOMException('Injected quota failure', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await page.locator('.vibe-add-btn').click();
  await page.locator('[data-add="shot"]').click();
  await page.locator('.vibe-attachment-status').filter({ hasText: /quota/i }).waitFor();
  assert.equal(await page.locator('.vibe-att-tile').count(), 0, 'failed IDB commit cannot create a preview/link');
  await capture();
  await capture('region');
  assert.equal(await page.locator('.vibe-att-tile').count(), 2);
  await page.locator('.vibe-att-img').first().click();
  assert.equal(await page.locator('.vibe-local-preview img').evaluate(async img => { await img.decode(); return img.naturalWidth > 0; }), true);
  const downloadReady = page.waitForEvent('download');
  await page.locator('.vibe-local-preview a').click();
  const downloaded = await readFile(await (await downloadReady).path());
  assert.equal(downloaded.toString('ascii', 0, 4), 'RIFF');
  assert.equal(downloaded.toString('ascii', 8, 12), 'WEBP');
  await page.locator('.vibe-preview-close').click();
  await page.locator('.vibe-textarea').fill('Two local captures');
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    let rejectNext = true;
    chrome.storage.local.set = data => {
      if (rejectNext && data.annotations?.some(a => a.comment === 'Two local captures')) {
        rejectNext = false;
        return Promise.reject(new Error('Injected annotation storage failure'));
      }
      return original(data);
    };
  });
  await page.locator('.vibe-save-btn').click();
  await page.locator('.vibe-attachment-status').filter({ hasText: 'Injected annotation storage failure' }).waitFor();
  assert.ok(!(await rows()).some(a => a.comment === 'Two local captures'), 'failed Save must not publish success');
  assert.equal(await page.locator('.vibe-att-tile').count(), 2, 'retry retains committed draft images');
  await page.locator('.vibe-save-btn').click();
  await page.locator('.vibe-popover').waitFor({ state: 'detached' });
  const saved = (await rows()).find(a => a.comment === 'Two local captures');
  assert.equal(saved.attachments.length, 2);
  assert.equal(new Set(saved.attachments.map(a => a.id)).size, 2);
  assert.ok(saved.attachments.every(a => a.local_only && a.byte_length > 0));
  assert.deepEqual(saved.attachments.map(a => a.capture_mode).sort(), ['element', 'region']);
  console.log('PASS two unique captures, local preview/download, awaited save');
  await page.locator(`[data-annotation-id="${saved.id}"]`).click();
  await capture();
  await page.locator('.vibe-att-remove').first().click();
  await page.locator('.vibe-cancel-btn').click();
  await page.locator('.vibe-popover').waitFor({ state: 'detached' });
  assert.equal((await rows()).find(a => a.id === saved.id).attachments.length, 2, 'edit Cancel preserves original references');
  console.log('PASS failed Save retains retryable draft; edit Cancel discards only new images');
  await openNew('#draft-target'); await capture();
  await page.locator('.vibe-att-remove').click();
  await page.locator('.vibe-att-tile').waitFor({ state: 'detached' });
  await capture();
  await page.locator('.vibe-cancel-btn').click();
  await page.locator('.vibe-popover').waitFor({ state: 'detached' });
  assert.ok(!(await worker.evaluate(() => httpAttempts)).some(url => /attachments|capture/.test(url)));
  await browser.close();
  await launch();
  const restored = (await rows()).find(a => a.id === saved.id);
  assert.equal(restored.attachments.length, 2);
  // Ask via a real extension page so the worker handles normal Chrome messaging.
  const extensionPage = await browser.newPage();
  await extensionPage.goto(worker.url().replace(/\/[^/]*$/, '/manifest.json'));
  const read = async id => extensionPage.evaluate(id => chrome.runtime.sendMessage({ action: 'readLocalAttachment', id }), id);
  for (const attachment of restored.attachments) {
    const result = await read(attachment.id);
    assert.equal(result.success, true, result.error);
    assert.ok(result.dataUrl.startsWith('data:image/webp;base64,'));
    assert.ok(result.dataUrl.length > 100);
  }
  const listing = await extensionPage.evaluate(() => chrome.runtime.sendMessage({ action: 'listLocalAttachments' }));
  assert.equal(listing.success, true, listing.error);
  assert.equal(listing.attachments.length, 2, 'cancel deleted only draft bytes');
  console.log('PASS browser restart reads actual webp bytes; cancelled draft leaves no orphan');
  const storeBundle = await build({ entryPoints: [join(extension, 'lib/background/local-attachments.js')], bundle: true, write: false, format: 'iife', globalName: 'LocalStoreFixture' });
  const limits = await extensionPage.evaluate(storeBundle.outputFiles[0].text + `
    (async () => {
      const store = LocalStoreFixture;
      const original = await store.listLocalAttachments();
      const fields = { draft_id: 'quota-fixture', capture_mode: 'element', mime: 'image/webp', width: 1, height: 1 };
      let imageError, totalError;
      try { await store.createLocalAttachment({ ...fields, blob: new Blob([new Uint8Array(15 * 1024 * 1024 + 1)]) }); }
      catch (error) { imageError = error.message; }
      const blob = new Blob([new Uint8Array(15 * 1024 * 1024)], { type: 'image/webp' });
      for (let i = 0; i < 6; i++) await store.createLocalAttachment({ ...fields, blob });
      try { await store.createLocalAttachment({ ...fields, blob }); }
      catch (error) { totalError = error.message; }
      await store.discardLocalDraft('quota-fixture');
      const retained = await store.listLocalAttachments();
      // Seed the crash boundary in real IDB: one old draft and old bound records.
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('vibe-annotations-local-attachments');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('attachments', 'readwrite');
        const records = tx.objectStore('attachments');
        const request = records.get(original[0].id);
        request.onsuccess = () => {
          const old = { ...request.result, created_at: new Date(Date.now() - 25 * 3600000).toISOString() };
          records.put(old);
          const orphan = { ...old, id: 'old-draft-fixture', draft_id: 'old-draft' };
          delete orphan.annotation_id;
          records.put(orphan);
        };
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
      db.close();
      const afterCleanup = await store.listLocalAttachments();
      return { imageError, totalError, retained: retained.map(a => a.id), afterCleanup: afterCleanup.map(a => a.id) };
    })()
  `);
  assert.match(limits.imageError, /15 MiB/);
  assert.match(limits.totalError, /100 MiB/);
  assert.deepEqual(limits.retained.sort(), saved.attachments.map(a => a.id).sort());
  assert.deepEqual(limits.afterCleanup.sort(), saved.attachments.map(a => a.id).sort());
  console.log('PASS 15 MiB/image and 100 MiB total limits preserve saved bytes; 24h cleanup removes only expired draft');
  await page.bringToFront();
  await page.locator(`[data-annotation-id="${saved.id}"]`).click();
  await page.locator('.vibe-att-remove').first().click();
  await page.locator('.vibe-save-btn').click();
  await page.locator('.vibe-popover').waitFor({ state: 'detached' });
  assert.equal((await read(saved.attachments[0].id)).success, false, 'saved image removal deletes bytes');
  const retainedImage = await read(saved.attachments[1].id);
  assert.equal(retainedImage.success, true, retainedImage.error);
  // Keep a separate bound image to prove deleting one annotation is isolated.
  const clearFixture = await extensionPage.evaluate(storeBundle.outputFiles[0].text + `
    (async () => {
      const blob = await (await fetch(${JSON.stringify((await read(saved.attachments[1].id)).dataUrl)})).blob();
      const attachment = await LocalStoreFixture.createLocalAttachment({
        draft_id: 'clear-draft', capture_mode: 'element', mime: blob.type, width: 1, height: 1, blob
      });
      const saved = await chrome.runtime.sendMessage({ action: 'saveAnnotation', localDraftId: 'clear-draft',
        annotation: { id: 'clear-fixture', url: ${JSON.stringify(origin + '/')}, selector: '#draft-target', comment: 'Clear fixture', attachments: [attachment] } });
      if (!saved.success) throw new Error(saved.error);
      return attachment;
    })()
  `);
  const removed = await extensionPage.evaluate(id => chrome.runtime.sendMessage({ action: 'deleteAnnotation', id }), saved.id);
  assert.equal(removed.success, true, removed.error);
  assert.equal((await read(saved.attachments[1].id)).success, false);
  assert.equal((await read(clearFixture.id)).success, true, 'deleting an annotation preserves unrelated image bytes');
  console.log('PASS saved image removal and annotation deletion remove only their own bytes');
  await page.bringToFront();
  await page.locator('.vibe-tb-settings').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.vibe-clear-local-images-btn').click();
  await page.waitForFunction(() => {
    const root = document.querySelector('#vibe-annotations-root')?.shadowRoot;
    return root?.querySelector('.vibe-clear-local-images-btn')?.disabled === false;
  });
  assert.equal((await read(clearFixture.id)).success, false);
  assert.ok((await rows()).some(a => a.comment === 'Text without automatic capture'));
  assert.ok((await rows()).every(a => !(a.attachments || []).some(att => att.local_only)));
  console.log('PASS confirmed Settings clear removes local bytes/refs but preserves text annotations');
  assert.deepEqual(pageErrors, [], 'browser UI must not emit uncaught exceptions');
} catch (error) {
  console.error('CAPTURE STATE', await page?.locator('.vibe-attachment-status').allTextContents().catch(() => []));
  throw error;
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
  await rm(profile, { recursive: true, force: true });
}
