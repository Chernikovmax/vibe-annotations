// Export boundary: real extension UI, extension-origin IDB bytes, review privacy, and ZIP contents.
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const require = createRequire(join(process.env.ANGULAR_DEPS || '/tmp/va-stage1-ng20', 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'va-local-export-'));
const server = createServer((_req, res) => res.end('<!doctype html><title>export fixture</title>'));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, downloadProtocol;
const waitForDownloadRecords = (page, count) => page.evaluate(count => new Promise((resolve, reject) => {
  const check = async () => {
    const { vibeImageDownloads = [] } = await chrome.storage.local.get('vibeImageDownloads');
    if (vibeImageDownloads.length !== count) return;
    clearTimeout(timer);
    chrome.storage.onChanged.removeListener(changed);
    resolve();
  };
  const changed = changes => { if (changes.vibeImageDownloads) check(); };
  const timer = setTimeout(() => {
    chrome.storage.onChanged.removeListener(changed);
    reject(new Error('Download cleanup did not reach the expected state'));
  }, 15000);
  chrome.storage.onChanged.addListener(changed);
  check();
}), count);
try {
  const unpacked = join(extension, '.output/chrome-mv3');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: join(profile, 'downloads'), prompt_for_download: false } }));
  browser = await chromium.launchPersistentContext(profile, { headless: !process.env.HEADED, channel: 'chromium', acceptDownloads: true, args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`, '--host-resolver-rules=MAP clipboard.test 127.0.0.1', '--no-proxy-server'] });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => { globalThis.fetch = () => Promise.reject(new Error('Offline export fixture')); });
  const page = await browser.newPage(); await page.goto(origin); await page.waitForFunction(() => window.__vibeAnnotations);
  const extensionPage = await browser.newPage(); await extensionPage.goto(worker.url().replace(/\/[^/]*$/, '/manifest.json'));
  const bundle = await build({ entryPoints: [join(extension, 'lib/background/local-attachments.js')], bundle: true, write: false, format: 'iife', globalName: 'LocalStoreFixture' });
  const seeded = await extensionPage.evaluate(bundle.outputFiles[0].text + `
    (async () => {
      const store = LocalStoreFixture;
      const canvas = new OffscreenCanvas(24,16); const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f0'; ctx.fillRect(0,0,12,16); ctx.fillStyle = '#00f'; ctx.fillRect(12,0,12,16);
      const blob = await canvas.convertToBlob({type:'image/webp',quality:0.85});
      const att = await store.createLocalAttachment({draft_id:'export-fixture',capture_mode:'element',mime:blob.type,width:24,height:16,blob});
      const excludedImage = await store.createLocalAttachment({draft_id:'export-fixture',capture_mode:'region',mime:blob.type,width:24,height:16,blob});
      const annotation = {id:'export-fixture',url:${JSON.stringify(origin+'/secret?token=SENSITIVE#part')},url_path:'/secret?token=SENSITIVE#part',status:'pending',type:'element',comment:'Keep this note',selector:'#private',source_file_path:'/tmp/PRIVATE_SOURCE.ts',parent_chain:[{text:'PARENT_SECRET'}],attachments:[att,excludedImage,{id:'legacy',kind:'capture',url:'blob:FALSE_IMAGE_URL',path:'/FAKE/legacy.webp'}],element_context:{tag:'button',id:'DOM_SECRET',text:'DOM_SECRET_TEXT',aria_label:'ARIA_SECRET',classes:['secret-class'],attributes:{'data-testid':'ok'},path:'html > button',target_identity:{tag:'button',attributes:{'data-testid':'ok'}},angular:{component:'DemoComponent',template_owner:{name:'DemoComponent'},hosted_component:{name:'ChildComponent'},chain:{status:'observed',components:['DemoComponent'],stop_reason:'no_owner',limitations:['debug owner chain is incomplete']},input_names:['userSecret'],inputs:{userSecret:'INPUT_VALUE_SECRET'}}}};
      const other = {...annotation,id:'excluded-annotation',comment:'EXCLUDED_ANNOTATION',attachments:[]};
      await chrome.storage.local.set({annotations:[annotation,other],vibeClearOnCopy:true});
      return {id:att.id, excludedId:excludedImage.id, annotation, other, bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
    })()
  `);
  await page.locator('.vibe-toolbar').hover({ position: { x: 12, y: 12 } });
  const beforeDrag = await page.locator('.vibe-toolbar').boundingBox();
  const handle = await page.locator('.vibe-toolbar-logo').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 24, handle.y + handle.height / 2 + 16, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await page.locator('.vibe-toolbar').boundingBox();
  assert.ok(afterDrag.x < beforeDrag.x - 16 && afterDrag.y > beforeDrag.y + 8, 'toolbar chrome remains draggable');
  await page.locator('.vibe-tb-settings').click();
  await page.locator('.vibe-copy-mode').selectOption('review');
  await page.waitForFunction(() => !document.querySelector('#vibe-annotations-root').shadowRoot.querySelector('.vibe-copy-mode').disabled);
  await page.locator('.vibe-tb-viewall').click();
  const exportButton = page.locator('.vibe-viewall-export'); await exportButton.click();
  await page.locator('.vibe-share-opt').click();
  await page.locator('.vibe-export-review').waitFor();
  assert.equal(await page.locator('.vibe-export-preview').first().evaluate(async img => { await img.decode(); return img.naturalWidth; }),24,'real local preview decodes before export');
  for (const path of ['/element_context/text','/element_context/id','/element_context/aria_label','/parent_chain','/source_file_path','/element_context/angular/input_names/0']) await page.locator(`[data-field="export-fixture:${path}"]`).uncheck();
  await page.locator(`[data-image="export-fixture:${seeded.excludedId}"]`).uncheck();
  await page.locator('.vibe-export-review input[data-id="excluded-annotation"]').uncheck();
  const downloadPromise = page.waitForEvent('download'); await page.locator('[data-action="continue"]').click();
  const download = await downloadPromise; const archivePath = await download.path();
  const { execFileSync } = await import('node:child_process');
  const listing = execFileSync('unzip', ['-Z1', archivePath], {encoding:'utf8'}).trim().split('\n');
  assert.deepEqual(listing.sort(), ['annotations.json','annotations.md',`attachments/${seeded.id}.webp`].sort());
  const json = JSON.parse(execFileSync('unzip', ['-p',archivePath,'annotations.json'], {encoding:'utf8'}));
  const exported = json.annotations[0];
  assert.equal(exported.url, origin+'/secret'); assert.equal(exported.element_context.text, undefined);
  assert.equal(exported.element_context.angular.inputs, undefined); assert.ok(!exported.element_context.angular.input_names?.includes('userSecret'));
  assert.equal(json.attachments[0].annotation_id,'export-fixture');
  const md = execFileSync('unzip', ['-p',archivePath,'annotations.md'], {encoding:'utf8'});
  assert.match(md,/attachments\//);
  assert.doesNotMatch(JSON.stringify(json)+md,/SENSITIVE|INPUT_VALUE_SECRET|DOM_SECRET|ARIA_SECRET|PARENT_SECRET|PRIVATE_SOURCE|EXCLUDED_ANNOTATION|blob:|chrome-extension:|FALSE_IMAGE_URL|FAKE/);
  assert.equal(exported.attachments.find(a=>a.id==='legacy').unavailable,true);
  const image = execFileSync('unzip', ['-p',archivePath,`attachments/${seeded.id}.webp`]);
  assert.deepEqual(image,Buffer.from(seeded.bytes),'archive contains exact committed WebP bytes');
  await extensionPage.evaluate(async bytes => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/webp'})); if(bitmap.width!==24||bitmap.height!==16) throw new Error('Wrong exported image geometry'); bitmap.close(); }, [...image]);
  assert.deepEqual((await worker.evaluate(async () => (await chrome.storage.local.get('annotations')).annotations)),[seeded.annotation,seeded.other],'export leaves original annotations and excluded images intact');
  assert.equal((await extensionPage.evaluate(id=>chrome.runtime.sendMessage({action:'readLocalAttachment',id}),seeded.excludedId)).success,true);
  console.log('PASS reviewed ZIP contains local bytes and stripped reviewed context');
  await browser.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await page.bringToFront();
  // A physical click may move a few pixels while held. Copy is not a drag handle.
  const toolbarBeforeCopy = await page.locator('.vibe-toolbar').boundingBox();
  const copyBox = await page.locator('.vibe-viewall-copy').boundingBox();
  await page.mouse.move(copyBox.x + copyBox.width / 2 - 3, copyBox.y + copyBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(copyBox.x + copyBox.width / 2 + 3, copyBox.y + copyBox.height / 2, { steps: 3 });
  await page.mouse.up();
  assert.deepEqual(await page.locator('.vibe-toolbar').boundingBox(), toolbarBeforeCopy, 'pressing Copy must not drag the toolbar or swallow its click');
  await page.locator('.vibe-export-review').waitFor();
  await page.locator('[data-field="export-fixture:/element_context"]').uncheck();
  await page.locator('.vibe-export-review input[data-id="excluded-annotation"]').uncheck();
  await page.locator('[data-action="continue"]').click();
  await page.locator('.vibe-export-review').waitFor({state:'detached'});
  const copied = await page.evaluate(()=>navigator.clipboard.readText());
  assert.match(copied,/Copied text does not transfer image bytes/);
  assert.doesNotMatch(copied,/attachments\/|INPUT_VALUE_SECRET|DOM_SECRET|SENSITIVE/);
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('annotations')).annotations)).length,2,'legacy clearOnCopy must not delete export originals');
  console.log('PASS reviewed clipboard excludes context, does not claim image files, and never deletes originals');
  downloadProtocol = await browser.browser().newBrowserCDPSession();
  // CDP's "allow" / "allowAndName" override extension filenames. Restore the real
  // browser download manager to exercise filename/subdirectory behavior.
  await downloadProtocol.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  await page.locator('.vibe-viewall-copy').click();
  await page.locator('[data-copy-format]').selectOption('omp');
  for (const path of ['/element_context/angular/template_owner', '/element_context/target_identity/attributes', '/element_context/text', '/element_context/id', '/element_context/aria_label', '/parent_chain']) await page.locator(`[data-field="export-fixture:${path}"]`).uncheck();
  await page.locator('.vibe-export-review input[data-id="excluded-annotation"]').uncheck();
  await page.locator(`[data-image="export-fixture:${seeded.excludedId}"]`).uncheck();
  await page.locator('[data-action="continue"]').click();
  await page.locator('.vibe-export-review').waitFor({state:'detached'});
  const omp = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(omp, /## A-export-fixture/);
  assert.match(omp, /Screenshot file: /);
  assert.match(omp, /Image expires: /);
  assert.match(omp, /Image unavailable: Legacy server image/);
  assert.doesNotMatch(omp, /Search guidance|data-testid|DOM_SECRET|ARIA_SECRET|PARENT_SECRET|SENSITIVE|PRIVATE_SOURCE|INPUT_VALUE_SECRET|EXCLUDED_ANNOTATION|blob:|attachments\/|\/FAKE\/|@file/);
  const imagePath = JSON.parse(omp.match(/^Screenshot file: (.+)$/m)[1]);
  assert.ok(imagePath.includes('/Remarker/'), 'handoff points into the download subdirectory');
  assert.deepEqual(await readFile(imagePath), Buffer.from(seeded.bytes), 'copied absolute path resolves to exact exported image bytes');
  const imageRecords = await worker.evaluate(async () => (await chrome.storage.local.get('vibeImageDownloads')).vibeImageDownloads);
  assert.equal(imageRecords.length, 1, 'excluded annotation/image and legacy bytes are not downloaded');
  assert.ok(Math.abs(imageRecords[0].expiresAt - Date.now() - 48 * 60 * 60 * 1000) < 10000);
  assert.deepEqual((await worker.evaluate(async () => (await chrome.storage.local.get('annotations')).annotations)),[seeded.annotation,seeded.other]);
  console.log('PASS OMP reviewed exclusions, exact image bytes at copied absolute path, 48h lifetime, originals intact');
  await worker.evaluate(() => {
    globalThis.originalImageDownload = chrome.downloads.download;
    chrome.downloads.download = async () => { throw new Error('Download denied by browser'); };
  });
  await page.locator('.vibe-viewall-copy').click();
  await page.locator('[data-copy-format]').selectOption('omp');
  await page.locator('[data-action="continue"]').click();
  await page.locator('.vibe-export-error').filter({ hasText: /Download denied/ }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), omp, 'failed download leaves clipboard unchanged');
  await page.locator('[data-action="cancel"]').click();
  await worker.evaluate(() => { chrome.downloads.download = originalImageDownload; delete globalThis.originalImageDownload; });
  console.log('PASS browser download failure is visible and never copies an unconfirmed path');
  await worker.evaluate(async annotation => {
    await chrome.storage.local.set({annotations: [{
      ...annotation, id:'legacy-note', comment:'Legacy note', attachments:[],
      element_context:{tag:'button',text:'Legacy button'},
      context_hints:['Angular component: LegacyComponent','inputs: INPUT_VALUE_SECRET', 'Source: /FAKE/legacy.ts'],
    }]});
  }, seeded.annotation);
  for (const exclude of [false, true]) {
    await page.locator('.vibe-viewall-copy').click();
    await page.locator('[data-copy-format]').selectOption('omp');
    if (exclude) await page.locator('[data-field="legacy-note:/legacy_search_hints"]').uncheck();
    await page.locator('[data-action="continue"]').click();
    await page.locator('.vibe-export-review').waitFor({state:'detached'});
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(text.includes('LegacyComponent'), !exclude);
    assert.doesNotMatch(text, /Template owner:|INPUT_VALUE_SECRET|\/FAKE\//);
  }
  await worker.evaluate(async annotations => chrome.storage.local.set({annotations}), [seeded.annotation,seeded.other]);
  console.log('PASS legacy identifier hints are reviewed fallback only, without inputs or invented owner');
  await worker.evaluate(async () => { const data = await chrome.storage.local.get('annotations'); data.annotations[0].attachments[0].id='missing-local-bytes'; await chrome.storage.local.set(data); });
  await exportButton.click(); await page.locator('.vibe-share-opt').click(); await page.locator('.vibe-export-review').waitFor();
  await page.locator('[data-action="continue"]').click();
  await page.locator('.vibe-export-error').filter({hasText:/unavailable/i}).waitFor();
  assert.equal(await page.locator('[data-action="continue"]').isVisible(),true,'missing bytes do not report export success');
  console.log('PASS missing local bytes produce visible hard error');
  await page.locator('[data-action="cancel"]').click();
  await page.locator('.vibe-viewall-copy').click();
  await page.locator('[data-copy-format]').selectOption('omp');
  const beforeFailure = await page.evaluate(() => navigator.clipboard.readText());
  await page.locator('[data-action="continue"]').click();
  await page.locator('.vibe-export-error').filter({ hasText: /unavailable/i }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), beforeFailure, 'missing bytes cannot copy a false path or replace clipboard');
  await page.locator('[data-image="export-fixture:missing-local-bytes"]').uncheck();
  await page.locator(`[data-image="export-fixture:${seeded.excludedId}"]`).uncheck();
  await page.locator('[data-action="continue"]').click();
  await page.locator('.vibe-export-review').waitFor({state:'detached'});
  const missingImageText = await page.evaluate(() => navigator.clipboard.readText());
  assert.doesNotMatch(missingImageText, /Screenshot file:|missing-local-bytes|blob:|attachments\//);
  console.log('PASS missing image bytes fail visibly without touching clipboard; exclusion allows text-only handoff');
  const insecure = await browser.newPage();
  await insecure.goto(`http://clipboard.test:${server.address().port}`);
  await insecure.waitForFunction(() => window.__vibeAnnotations);
  assert.equal(await insecure.evaluate(() => window.isSecureContext), false);
  await insecure.locator('.vibe-tb-viewall').waitFor();
  const toolbarCopy = insecure.getByRole('button', { name: 'Copy', exact: true });
  assert.equal(await toolbarCopy.isVisible(), false, 'Copy is hidden when this project has no annotations');
  await worker.evaluate(async url => {
    await chrome.storage.local.remove('vibeCopyMode');
    await chrome.storage.local.set({ annotations: [{
      id: 'http-copy', url: url + '?secret=NO_QUERY#fragment', status: 'pending', type: 'element', selector: '#undefined',
      comment: 'Copy from plain HTTP\nСценарий: повторный вход\nНаблюдение: пункт доступен',
      parent_chain: [{ tag: 'mat-menu', text_sample: 'OMIT_PARENT_TEXT' }, { tag: 'main' }, { tag: 'third-parent' }],
      element_context: {
        text: 'Включить редактор', target_identity: { tag: 'button', classes: ['mdc-button', 'mat-mdc-button', 'awp-menu-action'], attributes: { 'data-testid': 'enable-builder', translate: 'MENU.ENABLE_BUILDER' }, match_count: 2 },
        angular: { chain: { components: ['RoleComponent', 'MatMenu', 'MenuComponent'], hosts: { MenuComponent: 'awp-menu' }, stop_reason: 'no_owner' }, input_names: ['INTERNAL_INPUT'] },
        state: { disabled: false, 'aria-disabled': 'false', visible: true }, styles: { opacity: '1', position: 'OMIT_STYLE' },
        translation_key: 'MENU.ENABLE_BUILDER', position: { width: 901, height: 53, x: 1236, y: 514 },
      },
    }, { id: 'layout-note', url, selector: '#layout-target', comment: 'Layout: Align the button', status: 'pending', type: 'element', element_context: { position: { width: 100, height: 25, x: 50, y: 75 } } }] });
  }, insecure.url());
  await toolbarCopy.click();
  await insecure.getByRole('status').filter({ hasText: /^Copied$/ }).waitFor();
  assert.equal(await insecure.locator('.vibe-viewall-panel').isVisible(), false, 'Copy does not open View all');
  assert.equal(await insecure.locator('.vibe-export-review').count(), 0, 'default OMP copy must not open a review');
  await page.bringToFront();
  const direct = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(direct, /A-http-copy · Page:/);
  assert.match(direct, /^Anchor chain: data-testid="enable-builder" \(0 up\)$/m);
  assert.match(direct, /^Target: button\.awp-menu-action · translate="MENU\.ENABLE_BUILDER"$/m);
  assert.match(direct, /^State: default$/m);
  assert.match(direct, /^Owner: RoleComponent → MenuComponent \(awp-menu\)$/m);
  assert.match(direct, /^Text: <static: i18n>$/m);
  assert.doesNotMatch(direct, /^(?:Context|Guard):/m);
  assert.doesNotMatch(direct, /Включить редактор|mat-mdc|MatMenu|opacity=1/);
  assert.match(direct, /Scenario: повторный вход\nObservation: пункт доступен/);
  assert.match(direct, /A-layout-note[\s\S]*Layout: rect 100×25 @ \(50, 75\)/);
  assert.doesNotMatch(direct, /#undefined|NO_QUERY|INTERNAL_INPUT|OMIT_STYLE|OMIT_PARENT_TEXT|third-parent|901×53|match_count|stop_reason|Search guidance/);
  console.log('PASS toolbar Copy on plain HTTP: actual OMP clipboard, no View all or review dialog');
  await worker.evaluate(() => chrome.storage.local.set({ vibeCopyMode: 'review' }));
  await insecure.bringToFront();
  await toolbarCopy.click();
  await insecure.locator('[data-copy-format]').waitFor();
  await insecure.locator('[data-action="cancel"]').click();
  await insecure.locator('.vibe-export-review').waitFor({ state: 'detached' });
  // Cleanup owns only tracked exports, not a regular ZIP or a newer image.
  await worker.evaluate(async annotations => chrome.storage.local.set({ annotations }), [seeded.annotation]);
  await toolbarCopy.waitFor({ state: 'hidden' });
  console.log('PASS toolbar Copy respects review mode and disappears after the last project annotation is removed');
  const newer = await extensionPage.evaluate(async ({ annotationId, attachmentId }) => {
    const response = await chrome.runtime.sendMessage({ action: 'exportLocalImages', images: [{ annotationId, attachmentId }] });
    if (!response.success) throw new Error(response.error);
    return response.images[0];
  }, { annotationId: 'export-fixture', attachmentId: seeded.id });
  assert.deepEqual(await readFile(newer.path), Buffer.from(seeded.bytes));
  await worker.evaluate(async () => {
    const { vibeImageDownloads } = await chrome.storage.local.get('vibeImageDownloads');
    vibeImageDownloads[0].expiresAt = Date.now() - 1000;
    await chrome.storage.local.set({ vibeImageDownloads });
    await chrome.alarms.create('vibe-image-download-cleanup', { when: Date.now() + 1000 });
  });
  await waitForDownloadRecords(extensionPage, 1);
  await assert.rejects(access(imagePath), { code: 'ENOENT' });
  assert.deepEqual(await readFile(newer.path), Buffer.from(seeded.bytes));
  await access(archivePath);
  console.log('PASS actual alarm deletes only expired export; newer image, ordinary ZIP and IDB originals remain');
  await extensionPage.evaluate(async () => {
    const { vibeImageDownloads } = await chrome.storage.local.get('vibeImageDownloads');
    vibeImageDownloads[0].expiresAt = Date.now() - 1000;
    await chrome.storage.local.set({ vibeImageDownloads });
    await chrome.alarms.clear('vibe-image-download-cleanup');
  });
  await browser.close();
  browser = await chromium.launchPersistentContext(profile, { headless: !process.env.HEADED, channel: 'chromium', args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
  const restartedWorker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const manager = await browser.newPage();
  await manager.goto(restartedWorker.url().replace(/\/[^/]*$/, '/manifest.json'));
  await waitForDownloadRecords(manager, 0);
  await assert.rejects(access(newer.path), { code: 'ENOENT' });
  assert.ok(await manager.evaluate(() => chrome.alarms.get('vibe-image-download-cleanup')));
  const original = await manager.evaluate(id => chrome.runtime.sendMessage({ action: 'readLocalAttachment', id }), seeded.id);
  assert.equal(original.success, true);
  console.log('PASS browser restart cleans overdue file, recreates lost alarm, and retains original image');
} finally {
  await browser?.close(); await new Promise(r => server.close(r)); await rm(profile,{recursive:true,force:true});
}
