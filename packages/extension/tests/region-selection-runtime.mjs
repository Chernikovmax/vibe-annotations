// Real Chromium input/lifecycle boundary. No extension profile or page-event isolation claim.
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(join(process.env.ANGULAR_DEPS || '/tmp/va-stage1-ng20', 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ stdin: { contents: `import host from './lib/content/shadow-host.js'; import region from './lib/content/region-capture.js'; host.init(); host.getHost().style.display = ''; window.region = region;`, resolveDir: extension }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const start = async () => {
  // The old trailing guard is stage 4 scope, not this lifecycle test's contract.
  await page.waitForTimeout(450);
  await page.evaluate(() => { document.querySelector('#original').focus(); window.result = 'pending'; region.start().then(box => { window.result = box; }); });
  await page.locator('.vibe-region-shade').waitFor();
};
const result = async () => {
  await page.waitForFunction(() => window.result !== 'pending', null, { timeout: 2000 });
  assert.equal(await page.locator('.vibe-region-shade').count(), 0, 'selection overlay is removed');
  assert.equal(await page.evaluate(() => region.isActive()), false, 'selection can be started again');
  return page.evaluate(() => window.result);
};
const drag = async (from, to) => {
  await start(); await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 3 }); await page.mouse.up(); return result();
};
try {
  await page.setContent('<!doctype html><style>body{margin:0;min-height:2400px}</style><button id="original">Original focus</button>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  // Lost capture must cancel, rather than leave an overlay waiting forever.
  await start(); await page.mouse.move(100, 100); await page.mouse.down();
  await page.locator('.vibe-region-shade').evaluate(el => el.releasePointerCapture(1));
  await page.mouse.move(101, 101);
  assert.equal(await result(), null, 'lostpointercapture cancels');
  await page.mouse.up();
  for (const [from, to] of [[[100,100],[220,180]], [[220,100],[100,180]], [[100,180],[220,100]], [[220,180],[100,100]]]) {
    const box = await drag(from, to);
    assert.deepEqual({ left: box.left, top: box.top, width: box.width, height: box.height }, { left:100, top:100, width:120, height:80 });
  }
  assert.equal(await drag([100,100],[103,200]), null, 'thin selection is not accepted by area');
  assert.equal(await drag([100,100],[200,103]), null);
  assert.equal(await drag([100,100],[100,100]), null);
  const edge = await drag([799,599],[0,0]);
  assert.equal(edge.left, 0); assert.equal(edge.top, 0); assert.equal(edge.width, 799); assert.equal(edge.height, 599);
  const outside = await drag([100,100],[-40,-30]);
  assert.equal(outside.left, 0); assert.equal(outside.top, 0); assert.equal(outside.width, 100); assert.equal(outside.height, 100);
  await start(); await page.mouse.move(100,100); await page.mouse.down();
  await page.locator('.vibe-region-shade').evaluate(el => {
    el.dispatchEvent(new PointerEvent('pointerup', { pointerId:22, isPrimary:true, button:0, clientX:300, clientY:300 }));
    el.dispatchEvent(new PointerEvent('pointercancel', { pointerId:22, isPrimary:true }));
  });
  assert.equal(await page.evaluate(() => window.result), 'pending', 'another pointer cannot finish or cancel an active drag');
  await page.mouse.move(200,200); await page.mouse.up(); assert.equal((await result()).width, 100);
  await start(); await page.mouse.move(100,100); await page.mouse.down({ button:'right' }); await page.mouse.move(200,200); await page.mouse.up({ button:'right' });
  assert.equal(await page.evaluate(() => window.result), 'pending', 'non-primary button cannot select');
  await page.evaluate(() => region.cancel()); assert.equal(await result(), null);
  await start(); await page.keyboard.press('Escape'); assert.equal(await result(), null);
  await start(); await page.mouse.move(100,100); await page.mouse.down(); await page.keyboard.press('Escape'); assert.equal(await result(), null); await page.mouse.up();
  for (const type of ['pointercancel', 'lostpointercapture']) {
    await start(); await page.mouse.move(100,100); await page.mouse.down();
    await page.locator('.vibe-region-shade').evaluate((el, type) => el.dispatchEvent(new PointerEvent(type, { pointerId:1, isPrimary:true })), type);
    assert.equal(await result(), null, type); await page.mouse.up();
  }
  await start();
  await page.locator('.vibe-region-shade').evaluate(el => {
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerId:2, isPrimary:false, button:0, clientX:100, clientY:100 }));
    el.dispatchEvent(new PointerEvent('pointerup', { pointerId:2, isPrimary:false, button:0, clientX:250, clientY:250 }));
  });
  assert.equal(await page.evaluate(() => window.result), 'pending', 'secondary pointer cannot finish selection');
  await page.evaluate(() => region.cancel()); assert.equal(await result(), null);
  await start(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert.equal(await result(), null, 'window blur cancels');
  await start(); await page.setViewportSize({width:820,height:620}); assert.equal(await result(), null, 'real viewport resize cancels');
  await page.setViewportSize({width:800,height:600});
  await start(); await page.evaluate(() => scrollTo(0,100)); assert.equal(await result(), null, 'external scroll cancels');
  await page.evaluate(() => scrollTo(0,0));
  await start(); const before = await page.evaluate(() => scrollY); await page.mouse.wheel(0,150); await page.waitForTimeout(80); assert.equal(await page.evaluate(() => scrollY), before, 'wheel cannot scroll during selection'); await page.evaluate(() => region.cancel()); await result();
  assert.ok(await drag([50,50],[54,54]), '4 CSS px per side is accepted after cancellations');
  console.log('PASS real region directions, minimum sides, bounds, pointer/lost capture, Escape, blur/resize/scroll cancellation, wheel suppression and restart');
} finally { await browser.close(); }
