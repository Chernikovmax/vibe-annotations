// Actual extension UI + real Angular Material/CDK, isolated persistent Chromium profile.
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deps = resolve(process.env.ANGULAR_DEPS || '/tmp/va-stage1-ng20');
const require = createRequire(join(deps, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const fixture = await build({ entryPoints: [join(extension, 'tests/angular-runtime/main.js')], bundle: true, write: false, format: 'iife', keepNames: true, nodePaths: [join(deps, 'node_modules')] });
const overlay = await readFile(join(deps, 'node_modules/@angular/cdk/overlay-prebuilt.css'), 'utf8');
const theme = await readFile(join(deps, 'node_modules/@angular/material/prebuilt-themes/indigo-pink.css'), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? fixture.outputFiles[0].text : `<!doctype html><base href="/"><style>${overlay}\n${theme}\nbody{margin:0} fixture-dialog,fixture-nested-dialog{display:block;padding:24px;min-width:250px} button{padding:10px}</style><fixture-root></fixture-root><script src="/fixture.js"></script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const temp = await mkdtemp(join(tmpdir(), 'va-material-'));
let context, page;
try {
  const unpacked = join(extension, '.output/chrome-mv3');
  context = await chromium.launchPersistentContext(join(temp, 'profile'), { headless: true, channel: 'chromium', viewport: { width: 1100, height: 850 }, args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.fetch = () => Promise.reject(new Error('Offline Material fixture'));
    // Interaction-only boundary: real region input, but no permission prompt or
    // screenshot bytes. GUI permission/crop acceptance belongs to capture-geometry-runtime.
    chrome.permissions.request = async () => true;
    chrome.tabs.captureVisibleTab = async () => { throw new Error('Capture intentionally disabled in interaction-only fixture'); };
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.fixtureReady && window.__vibeAnnotations);
  const count = () => page.locator('mat-dialog-container').count();
  const card = page.locator('.vibe-textarea');
  const host = page.locator('#vibe-annotations-root');
  const annotate = async (selector, hold = 0, keyboard = false) => {
    await page.locator('.vibe-tb-annotate').click();
    const target = page.locator(selector);
    const r = await target.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    if (keyboard) await page.keyboard.press('Enter');
    else { await page.mouse.down(); if (hold) await page.waitForTimeout(hold); await page.mouse.up(); }
    await card.waitFor();
  };
  const assertFocus = async () => assert.equal(await card.evaluate(el => el.getRootNode().activeElement === el), true, 'card keeps actual focus');
  const region = async () => {
    await page.locator('.vibe-add-btn').click();
    await page.locator('[data-add="region"]').click();
    await page.locator('.vibe-region-shade').waitFor();
  };
  await page.evaluate(() => window.fixture.open('plain'));
  console.log('Observed CDK surface', await page.locator('.cdk-overlay-container').evaluate(el => ({ tag: el.tagName, popover: el.getAttribute('popover'), topLayer: el.matches(':popover-open, :modal') })));
  await page.locator('[data-testid="dialog-action"]').waitFor();
  await annotate('[data-testid="dialog-action"]', 1000);
  assert.equal(await count(), 1, 'long selection never runs Material button action');
  await assertFocus();
  await card.fill('Material comment');
  await page.keyboard.press('Escape');
  await card.waitFor({ state: 'detached' });
  assert.equal(await count(), 1, 'card Escape does not close app dialog');
  assert.equal(await page.locator('[data-testid="dialog-action"]').evaluate(el => document.activeElement === el), true, 'closing restores focus to the selected page button');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('mat-dialog-container'));
  console.log('PASS long hold, card→app Escape, focus restore');
  // Short pointer and Enter select without activating the page button. Two real dialogs.
  await page.evaluate(() => { window.fixture.open('plain'); });
  await page.locator('[data-testid="dialog-action"]').click();
  assert.equal(await count(), 2);
  await annotate('[data-testid="nested-dialog"]');
  assert.equal(await count(), 2);
  await card.fill('Two dialogs');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.querySelector('#vibe-annotations-root').shadowRoot.activeElement?.closest('.vibe-popover')), true);
  await page.keyboard.press('Shift+Tab');
  await assertFocus();
  const controls = await page.locator('.vibe-popover').evaluate(el => [...el.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter(x => !x.disabled && x.tabIndex >= 0 && x.getClientRects().length).length);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < controls + 2; i++) {
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => !!document.querySelector('#vibe-annotations-root').shadowRoot.activeElement?.closest('.vibe-popover')), true, key + ' stays inside card across wrap');
    }
  }
  await card.focus();
  // Browser IME path rather than assigning textarea.value and claiming composition support.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '日本' });
  assert.match(await card.inputValue(), /日本/);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText(' pasted text'));
  await page.keyboard.press('ControlOrMeta+V');
  await page.waitForFunction(() => document.querySelector('#vibe-annotations-root').shadowRoot.querySelector('.vibe-textarea').value.includes('pasted text'));
  await region();
  await page.mouse.move(40, 40); await page.mouse.down(); await page.mouse.move(160, 130);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await page.locator('.vibe-region-shade').count(), 0);
  assert.equal(await count(), 2);
  await assertFocus();
  await page.keyboard.press('Escape');
  await card.waitFor({ state: 'detached' });
  assert.equal(await count(), 2);
  assert.equal(await page.locator('[data-testid="nested-dialog"]').evaluate(el => document.activeElement === el), true);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('fixture-nested-dialog')), true, 'native CDK focus trap resumes');
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('mat-dialog-container').length === 1);
  await page.locator('.cdk-overlay-backdrop').last().click({ position: { x: 10, y: 10 } });
  await page.waitForFunction(() => !document.querySelector('mat-dialog-container'));
  console.log('PASS nested dialogs, input/Tab/ShiftTab/paste/IME, region→card→app Escape, native backdrop');
  // Page click immediately following a completed selection is not a timed dead zone.
  await page.evaluate(() => window.fixture.open('plain'));
  await annotate('[data-testid="dialog-action"]', 0, true);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="dialog-action"]').click();
  await page.waitForFunction(() => document.querySelectorAll('mat-dialog-container').length === 2);
  await page.evaluate(() => window.fixture.dialog.closeAll());
  await page.waitForFunction(() => !document.querySelector('mat-dialog-container'));
  console.log('PASS Enter selection and next independent click');
  await page.evaluate(() => window.fixture.open('plain'));
  await annotate('[data-testid="dialog-action"]');
  await region();
  await page.mouse.move(20,20); await page.mouse.down(); await page.mouse.move(160,130); await page.mouse.up();
  assert.equal(await count(), 1, 'region drag above Material backdrop never closes dialog');
  await page.locator('.vibe-cancel-btn').click();
  await card.waitFor({ state: 'detached' });
  // Cancel resumes inspection. Exit it before verifying native backdrop behavior.
  await page.keyboard.press('Escape');
  await page.locator('.cdk-overlay-backdrop').click({ position: {x:10,y:10} });
  await page.waitForFunction(() => !document.querySelector('mat-dialog-container'));
  console.log('PASS completed region over backdrop and immediate independent UI click');
  // Top-layer popover and native modal inertness, using the same main UI rather than a mock card.
  for (const kind of ['popover', 'dialog']) {
    await page.evaluate(kind => {
      const el = document.createElement(kind === 'dialog' ? 'dialog' : 'div');
      el.id = 'native-layer'; el.style.cssText = 'padding:40px; background:white; color:black';
      el.innerHTML = '<button id="native-target">Native target</button><input id="native-input">';
      if (kind === 'popover') el.popover = 'manual';
      document.body.appendChild(el);
      if (kind === 'dialog') el.showModal(); else el.showPopover();
    }, kind);
    await annotate('#native-target');
    await assertFocus();
    assert.equal(await host.evaluate(el => el.matches(':popover-open')), true);
    const r = await card.boundingBox();
    assert.equal(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.id, {x:r.x+10,y:r.y+10}), 'vibe-annotations-root', 'actual hit-test above page top layer');
    await card.fill('Native layer');
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#native-layer').count(), 1);
    if (kind === 'dialog') {
      assert.equal(await page.evaluate(() => document.querySelector('#native-layer').open), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#native-layer').open);
    }
    await page.evaluate(() => document.querySelector('#native-layer').remove());
  }
  console.log('PASS manual popover top layer, native dialog hit-test/focus and staged Escape');
  await page.evaluate(() => window.fixture.open('plain'));
  await annotate('[data-testid="dialog-action"]');
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="dialog-action"]');
    const input = document.createElement('input');
    input.id = 'remaining-dialog-input';
    target.after(input);
    target.remove();
  });
  await page.keyboard.press('Escape');
  await card.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.isConnected && !!document.activeElement.closest('mat-dialog-container')), true, 'removed target restores to a safe live dialog element');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('mat-dialog-container'));
  for (let i = 0; i < 5; i++) {
    await annotate('[data-testid="conditional"]');
    await region();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
  }
  await annotate('[data-testid="conditional"]');
  await region();
  await page.evaluate(() => { history.pushState({}, '', '/changed'); document.title = 'SPA route'; });
  await page.locator('.vibe-region-shade').waitFor({ state: 'detached' });
  await card.waitFor({ state: 'detached' });
  await annotate('[data-testid="conditional"]');
  await region();
  await page.mouse.move(30,30); await page.mouse.down(); await page.mouse.move(180,160);
  await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true }); await chrome.tabs.sendMessage(tab.id, {action:'toggleOverlay'}); });
  await page.waitForFunction(() => document.querySelector('#vibe-annotations-root').style.display === 'none');
  // Deactivation hides the host synchronously; draft cleanup awaits the worker/IDB.
  await page.locator('.vibe-popover-anchor').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.vibe-region-shade').count(), 0);
  assert.equal(await page.locator('.vibe-popover-anchor').count(), 0);
  assert.equal(await host.evaluate(el => el.matches(':popover-open')), false);
  assert.equal(await page.locator('[data-vibe-cursor]').count(), 0);
  await page.mouse.up();
  await page.evaluate(() => {
    window.postDisableClicks = 0;
    document.querySelector('[data-testid="conditional"]').addEventListener('click', () => window.postDisableClicks++);
  });
  await page.locator('[data-testid="conditional"]').click();
  assert.equal(await page.evaluate(() => window.postDisableClicks), 1, 'disable releases pointer capture and event guards');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('cdk-global-scrollblock')), false, 'all native Material scroll locks released');
  assert.deepEqual(errors, []);
  console.log(`PASS repeat/SPA/disable cleanup; Angular ${require('@angular/core/package.json').version}, Material/CDK ${require('@angular/material/package.json').version}, Chromium ${context.browser().version()}`);
} catch (error) {
  console.error('Interaction failure state', await page?.evaluate(() => {
    const host = document.querySelector('#vibe-annotations-root');
    const toolbar = host?.shadowRoot.querySelector('.vibe-toolbar');
    return { toolbar: toolbar && { mode: toolbar.className, rect: toolbar.getBoundingClientRect().toJSON() }, topLayer: host?.matches(':popover-open'), parent: host?.parentElement?.tagName, focus: document.activeElement?.tagName, shadowFocus: host?.shadowRoot.activeElement?.className, dialogs: document.querySelectorAll('mat-dialog-container,dialog[open]').length };
  }));
  throw error;
} finally {
  await context?.close(); await new Promise(r => server.close(r)); await rm(temp, {recursive:true,force:true});
}
