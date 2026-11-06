import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '..');
const deps = process.env.ANGULAR_DEPS;
if (!deps) throw new Error('Set ANGULAR_DEPS to an installation containing Playwright');
const { chromium } = createRequire(join(resolve(deps), 'package.json'))('playwright');
const unpacked = join(extension, '.output/chrome-mv3');
const temp = await mkdtemp(join(tmpdir(), 'va-event-target-'));
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><button id="page-button">Page</button>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  const launch = { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) };
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    ...launch, channel: 'chromium',
    args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => { globalThis.fetch = () => Promise.reject(new Error('Offline event runtime fixture')); });
  const page = await context.newPage();
  page.on('pageerror', error => { pageErrors.push(error.message); });
  const pageErrors = [];
  await page.goto(origin);
  await page.waitForFunction(() => window.__vibeAnnotations && document.querySelector('#vibe-annotations-root'));
  const observations = await page.evaluate(() => {
    const host = document.querySelector('#vibe-annotations-root');
    const shadow = host.shadowRoot;
    const button = document.createElement('button');
    button.id = 'host-probe';
    shadow.append(button);
    const dispatchHost = (type, init = {}) => button.dispatchEvent(new Event(type, { bubbles: true, composed: true, cancelable: true, ...init }));
    const dispatchPage = (type, init = {}) => document.querySelector('#page-button').dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
    const state = detail => host.dispatchEvent(new CustomEvent('vibe-ui:state', { detail, bubbles: true, composed: true }));
    const register = el => el.dispatchEvent(new CustomEvent('vibe-ui:register', { bubbles: true, composed: true }));
    const result = {};

    // Unregistered and inactive hosts must be native passthrough; a same-id impostor cannot set state.
    let count = 0;
    const inactive = () => count++;
    document.addEventListener('click', inactive, true);
    const impostor = document.createElement('div'); impostor.id = host.id;
    const fakeButton = document.createElement('button'); impostor.attachShadow({ mode: 'open' }).append(fakeButton);
    document.body.append(impostor);
    register(host);
    impostor.dispatchEvent(new CustomEvent('vibe-ui:state', { detail: { active: true }, bubbles: true, composed: true }));
    fakeButton.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    result.impostorStateIgnored = count === 1;
    register(impostor);
    state({ active: false });
    dispatchHost('click'); dispatchPage('click');
    result.inactivePassthrough = count === 3;
    document.removeEventListener('click', inactive, true);

    // Active UI event suppression is bound to the currently registered host object, not its id.
    register(host); state({ active: true });
    let hostCount = 0, fakeCount = 0, pageCount = 0;
    const hostListener = event => {
      if (event.composedPath().includes(host)) hostCount++;
      else if (event.composedPath().includes(impostor)) fakeCount++;
      else pageCount++;
    };
    document.addEventListener('click', hostListener, true);
    impostor.dispatchEvent(new CustomEvent('vibe-ui:state', { detail: { active: false }, bubbles: true, composed: true }));
    dispatchHost('click'); fakeButton.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    dispatchPage('click');
    result.exactHostSuppressed = hostCount === 0;
    result.impostorHostEventPassed = fakeCount === 1;
    result.pageEventPassthrough = pageCount === 1;
    let wheelCount = 0;
    const onWheel = () => wheelCount++;
    document.addEventListener('wheel', onWheel, true);
    dispatchHost('wheel');
    result.wheelSuppressedForVisibleHost = wheelCount === 0;
    document.removeEventListener('wheel', onWheel, true);
    document.removeEventListener('click', hostListener, true);
    // Identity/capture dedupe preserves first options, order, and function this.
    state({ active: false });
    const order = [];
    function first() { order.push(this === document ? 'first-this-ok' : 'first-this-bad'); }
    function second() { order.push('second'); }
    document.addEventListener('click', first, { once: false, passive: false });
    document.addEventListener('click', first, { once: true, passive: true });
    document.addEventListener('click', second);
    dispatchPage('click'); dispatchPage('click');
    result.duplicateAndOrder = order.join(',') === 'first-this-ok,second,first-this-ok,second';
    document.removeEventListener('click', first, { capture: false });
    document.removeEventListener('click', first, false);
    document.removeEventListener('click', second);

    // once remains armed across swallowed host events and is removed before reentrant invocation.
    let onceCount = 0;
    const once = () => { onceCount++; if (onceCount === 1) dispatchPage('click'); };
    document.addEventListener('click', once, { once: true, capture: true });
    state({ active: true }); dispatchHost('click');
    result.onceSurvivesSuppression = onceCount === 0;
    state({ active: false }); dispatchPage('click'); dispatchPage('click');
    result.onceReentrantAndPruned = onceCount === 1;
    document.addEventListener('click', once, { once: true, capture: true });
    dispatchPage('click');
    result.onceCanReaddSameCallback = onceCount === 2;

    // Object handleEvent lookup and receiver are dynamic; same listener supports remove/re-add.
    const objectCalls = [];
    const objectListener = { handleEvent() { objectCalls.push('old'); } };
    document.addEventListener('click', objectListener);
    objectListener.handleEvent = function () { objectCalls.push(this === objectListener ? 'new-this-ok' : 'new-this-bad'); };
    dispatchPage('click');
    document.removeEventListener('click', objectListener, false);
    document.removeEventListener('click', objectListener, { capture: false });
    document.addEventListener('click', objectListener);
    dispatchPage('click'); document.removeEventListener('click', objectListener);
    result.dynamicHandleEvent = objectCalls.join(',') === 'new-this-ok,new-this-ok';

    // Separate capture identity and remove option forms; non-root targets remain native.
    let captureCalls = 0, elementCalls = 0;
    const captureListener = () => captureCalls++;
    document.addEventListener('click', captureListener, true);
    document.addEventListener('click', captureListener, false);
    document.removeEventListener('click', captureListener, { capture: true });
    dispatchPage('click');
    const child = document.createElement('div');
    child.addEventListener('click', () => elementCalls++);
    child.dispatchEvent(new Event('click'));
    document.removeEventListener('click', captureListener, false);
    result.captureIdentityAndRootScope = captureCalls === 1 && elementCalls === 1;
    const rootTargets = [];
    const rootListener = event => rootTargets.push(event.currentTarget);
    const roots = [window, document, document.documentElement, document.body];
    for (const target of roots) target.addEventListener('click', rootListener);
    dispatchPage('click');
    for (const target of roots) target.removeEventListener('click', rootListener);
    result.allPageRoots = rootTargets.length === roots.length && roots.every(target => rootTargets.includes(target));

    // Passive is preserved, and ordered root listeners receive the original Event object.
    const cancelable = new Event('click', { bubbles: true, cancelable: true });
    let passivePrevented = true, eventIdentity = false;
    const eventListener = event => { eventIdentity = event === cancelable; event.preventDefault(); passivePrevented = event.defaultPrevented; };
    document.addEventListener('click', eventListener, { passive: true });
    document.querySelector('#page-button').dispatchEvent(cancelable);
    result.passiveAndOriginalEvent = eventIdentity && !passivePrevented;
    document.removeEventListener('click', eventListener);
    // Native option dictionary conversion order and callback/signal errors survive wrapping.
    const optionOrder = [];
    const optionListener = () => {};
    document.addEventListener('click', optionListener, {
      get capture() { optionOrder.push('capture'); return false; },
      get once() { optionOrder.push('once'); return false; },
      get passive() { optionOrder.push('passive'); return false; },
      get signal() { optionOrder.push('signal'); return undefined; },
    });
    document.removeEventListener('click', optionListener);
    let invalidCallback = false, invalidSignal = false, recovered = 0;
    try { document.addEventListener('click', 42); } catch (error) { invalidCallback = error instanceof TypeError; }
    const recoveredListener = () => recovered++;
    try { document.addEventListener('click', recoveredListener, { signal: {} }); } catch (error) { invalidSignal = error instanceof TypeError; }
    document.addEventListener('click', recoveredListener);
    dispatchPage('click');
    document.removeEventListener('click', recoveredListener);
    result.nativeOptionsAndErrors = optionOrder.join(',') === 'capture,once,passive,signal'
      && invalidCallback && invalidSignal && recovered === 1;
    let removedGetterReads = 0;
    document.removeEventListener('click', optionListener, { get capture() { removedGetterReads++; return false; } });
    result.removeReadsCaptureOnce = removedGetterReads === 1;
    let callableOptionsCount = 0;
    const callableOptions = Object.assign(() => {}, { capture: true, once: true });
    const callableListener = () => callableOptionsCount++;
    document.addEventListener('click', callableListener, callableOptions);
    dispatchPage('click'); dispatchPage('click');
    let primitiveCaptureCount = 0;
    const primitiveListener = () => primitiveCaptureCount++;
    document.addEventListener('click', primitiveListener, 1);
    document.removeEventListener('click', primitiveListener, true);
    dispatchPage('click');
    result.optionUnionSemantics = callableOptionsCount === 1 && primitiveCaptureCount === 0;

    // Region Escape suppresses page addEventListener listeners even when focus is outside the host.
    let regionEscape = 0;
    const escapeListener = () => regionEscape++;
    document.addEventListener('keydown', escapeListener);
    state({ active: true, region: true });
    document.querySelector('#page-button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    state({ active: true, region: false });
    document.querySelector('#page-button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    result.regionEscapeAndInactiveRestore = regionEscape === 1;
    document.removeEventListener('keydown', escapeListener);

    // Aborted-before-add, abort cleanup, and fresh re-add are observable with the same callback.
    let abortCount = 0;
    const abortListener = () => abortCount++;
    const already = new AbortController(); already.abort();
    document.addEventListener('click', abortListener, { signal: already.signal });
    dispatchPage('click');
    const controller = new AbortController();
    document.addEventListener('click', abortListener, { signal: controller.signal });
    controller.abort(); dispatchPage('click');
    const revived = new AbortController();
    document.addEventListener('click', abortListener, { signal: revived.signal });
    dispatchPage('click'); document.removeEventListener('click', abortListener);
    result.abortCleanupAndReadd = abortCount === 1;
    let duplicateSignalCount = 0;
    const duplicateSignalListener = () => duplicateSignalCount++;
    const firstSignal = new AbortController(), duplicateSignal = new AbortController();
    document.addEventListener('click', duplicateSignalListener, { signal: firstSignal.signal });
    document.addEventListener('click', duplicateSignalListener, { signal: duplicateSignal.signal });
    duplicateSignal.abort(); dispatchPage('click');
    result.duplicateSignalDoesNotReplace = duplicateSignalCount === 1;
    firstSignal.abort();

    // Inspection suppresses only primary selection down and its own pointer tail; no unrelated click/down.
    state({ active: true, inspecting: true, gesture: { pointerId: 71, phase: 'down' } });
    let selected = 0, unrelated = 0;
    const onDown = event => { if (event.pointerId === 71) selected++; else unrelated++; };
    const onUp = event => { if (event.pointerId === 71) selected++; else unrelated++; };
    document.addEventListener('pointerdown', onDown); document.addEventListener('pointerup', onUp);
    const down = new PointerEvent('pointerdown', { bubbles: true, pointerId: 72, button: 0, isPrimary: true });
    document.querySelector('#page-button').dispatchEvent(down);
    const tail = new PointerEvent('pointerup', { bubbles: true, pointerId: 71 });
    document.querySelector('#page-button').dispatchEvent(tail);
    result.selectionAndTailRules = selected === 0 && unrelated === 0;
    const otherPrimary = new PointerEvent('pointerdown', { bubbles: true, pointerId: 74, button: 0, isPrimary: false });
    document.querySelector('#page-button').dispatchEvent(otherPrimary);
    let mouseDownCalls = 0;
    const onMouseDown = () => mouseDownCalls++;
    document.addEventListener('mousedown', onMouseDown);
    document.querySelector('#page-button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    state({ active: true, inspecting: false, gesture: null });
    const keyHits = [];
    const onKey = event => keyHits.push(event.key);
    document.addEventListener('keydown', onKey);
    state({ active: true, inspecting: true });
    for (const key of ['Enter', 'Escape', ' ']) document.querySelector('#page-button').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    result.selectionKeysAndPrimary = unrelated === 1 && mouseDownCalls === 0 && keyHits.join(',') === ' ';
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('pointerdown', onDown); document.removeEventListener('pointerup', onUp);
    // A new pointerdown/click is independent of an old gesture's tail.
    state({ active: true, inspecting: false, gesture: { pointerId: 71, phase: 'up' } });
    let newDown = 0, newClick = 0, compatMouseUp = 0;
    const onNewDown = () => newDown++;
    const onNewClick = () => newClick++;
    const onCompatMouseUp = event => { if (event.pointerId === undefined) compatMouseUp++; };
    document.addEventListener('pointerdown', onNewDown);
    document.addEventListener('click', onNewClick);
    document.addEventListener('mouseup', onCompatMouseUp);
    document.querySelector('#page-button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 73, button: 0 }));
    document.querySelector('#page-button').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    document.querySelector('#page-button').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    result.gestureDoesNotSuppressNextInput = newDown === 1 && compatMouseUp === 0 && newClick === 1;
    document.removeEventListener('pointerdown', onNewDown);
    document.removeEventListener('click', onNewClick);
    document.removeEventListener('mouseup', onCompatMouseUp);
    state({ active: true });
    let editorEvents = 0;
    const onEditor = () => editorEvents++;
    for (const type of ['beforeinput', 'paste', 'compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(type, onEditor);
    for (const type of ['beforeinput', 'paste', 'compositionstart', 'compositionupdate', 'compositionend']) dispatchHost(type);
    result.editorEventsSuppressed = editorEvents === 0;
    for (const type of ['beforeinput', 'paste', 'compositionstart', 'compositionupdate', 'compositionend']) document.removeEventListener(type, onEditor);
    state({ active: false, inspecting: false, gesture: null });

    // Property handlers and ancestor element capture listeners remain outside the root-wrapper boundary.
    let propertySeen = 0, ancestorSeen = 0, rootSeen = 0;
    document.onkeydown = () => propertySeen++;
    const ancestor = document.createElement('div');
    const nestedHost = document.createElement('span'); ancestor.append(nestedHost); document.body.append(ancestor);
    const onRoot = () => rootSeen++;
    document.addEventListener('click', onRoot, true);
    ancestor.addEventListener('click', () => ancestorSeen++, true);
    ancestor.append(host);
    register(host); state({ active: true });
    dispatchHost('click');
    nestedHost.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    dispatchHost('keydown');
    const iframe = document.createElement('iframe'); document.body.append(iframe);
    const savedAdd = iframe.contentWindow.EventTarget.prototype.addEventListener;
    const savedRemove = iframe.contentWindow.EventTarget.prototype.removeEventListener;
    let savedNativeSeen = 0;
    const nativeListener = () => savedNativeSeen++;
    savedAdd.call(document, 'pointermove', nativeListener, true);
    dispatchHost('pointermove');
    savedRemove.call(document, 'pointermove', nativeListener, true);
    iframe.remove();
    result.savedNativeBoundary = savedNativeSeen === 1;
    result.nativeBoundary = ancestorSeen === 2 && rootSeen === 1 && propertySeen === 1;
    document.removeEventListener('click', onRoot, true);
    document.onkeydown = null; ancestor.remove(); impostor.remove();
    state({ active: false });

    return result;
  });
  for (const [key, passed] of Object.entries(observations)) assert.equal(passed, true, key);
  // Native methods saved before installation and listeners registered before document_start bypass wrapping;
  // property handlers likewise remain native. Those boundaries are asserted above for property/ancestor listeners.
  await page.evaluate(() => {
    const fail = () => { throw new Error('listener failure preserved'); };
    document.addEventListener('click', fail, { once: true });
    document.querySelector('#page-button').dispatchEvent(new Event('click', { bubbles: true }));
    document.addEventListener('click', { handleEvent: null }, { once: true });
    document.querySelector('#page-button').dispatchEvent(new Event('click', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  assert.ok(pageErrors.some(message => message.includes('listener failure preserved')), 'native dispatch reports callback exception');
  assert.ok(pageErrors.some(message => /function|callable/i.test(message)), 'non-callable object handleEvent reports a native dispatch exception');
  await page.evaluate(() => {
    window.__eventListenerWeakRefs = (() => {
      const refs = [];
      const removed = () => {};
      refs.push(new WeakRef(removed)); document.addEventListener('click', removed); document.removeEventListener('click', removed);
      const once = () => {};
      refs.push(new WeakRef(once)); document.addEventListener('click', once, { once: true });
      document.querySelector('#page-button').dispatchEvent(new Event('click', { bubbles: true }));
      const controller = new AbortController();
      const aborted = () => {};
      refs.push(new WeakRef(aborted)); document.addEventListener('click', aborted, { signal: controller.signal }); controller.abort();
      return refs;
    })();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await page.evaluate(() => 0);
  assert.equal(await page.evaluate(() => window.__eventListenerWeakRefs.every(ref => ref.deref() === undefined)), true,
    'remove, once, and abort release callback references without registry stats');
  await cdp.detach();
  await page.evaluate(() => {
    window.laterAddPatch = function (...args) { return Reflect.apply(window.previousAdd, this, args); };
    window.previousAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = window.laterAddPatch;
  });
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['content-scripts/bridge.js'] });
  });
  assert.equal(await page.evaluate(() => {
    let calls = 0;
    const callback = () => calls++;
    document.addEventListener('click', callback);
    document.addEventListener('click', callback);
    document.querySelector('#page-button').click();
    document.removeEventListener('click', callback);
    const preserved = EventTarget.prototype.addEventListener === window.laterAddPatch && calls === 1;
    EventTarget.prototype.addEventListener = window.previousAdd;
    delete window.previousAdd; delete window.laterAddPatch;
    return preserved;
  }), true, 'repeat real bridge injection preserves a later patch without recursion or duplicate callbacks');
  console.log('PASS: installed-extension EventTarget identity, options, once, abort, dynamic callbacks, host protocol and native boundaries');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
