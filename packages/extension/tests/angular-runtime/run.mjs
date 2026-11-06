import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '../..');
const deps = process.env.ANGULAR_DEPS;
if (!deps) throw new Error('Set ANGULAR_DEPS to an isolated npm installation (see plan §7.1 results)');
const require = createRequire(join(resolve(deps), 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const temp = await mkdtemp(join(tmpdir(), 'va-angular-runtime-'));
const observe = process.argv.includes('--observe');
const fixture = await build({ entryPoints: [join(here, 'main.js')], bundle: true, write: false, format: 'iife', keepNames: true, nodePaths: [join(resolve(deps), 'node_modules')] });
const production = await build({ entryPoints: [join(here, 'main.js')], bundle: true, write: false, format: 'iife', minify: true, define: { ngDevMode: 'false' }, nodePaths: [join(resolve(deps), 'node_modules')] });
const contextBundle = await build({ stdin: { contents: `import context from ${JSON.stringify(join(extension, 'lib/content/element-context.js'))}; window.collectContext = context.generate;`, resolveDir: extension }, bundle: true, write: false, format: 'iife' });
const server = createServer((req, res) => {
  const script = req.url === '/fixture.js' || req.url === '/production.js';
  res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
  res.end(script ? (req.url === '/production.js' ? production : fixture).outputFiles[0].text
    : req.url === '/plain' ? '<!doctype html><button data-testid="plain">Plain</button>'
    : `<!doctype html><base href="/"><fixture-root></fixture-root><script src="${req.url.startsWith('/production') ? '/production.js' : '/fixture.js'}"></script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const launch = { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) };
  if (observe) {
    browser = await chromium.launch(launch);
  } else {
    const unpacked = join(extension, '.output/chrome-mv3');
    browser = await chromium.launchPersistentContext(join(temp, 'profile'), { ...launch, channel: 'chromium', args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`] });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    // Never send fixture annotations to a developer's MCP server.
    await worker.evaluate(() => { globalThis.fetch = () => Promise.reject(new Error('Offline fixture')); });
  }
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
  await page.goto(origin + '/lazy?private=query#private');
  await page.waitForFunction(() => window.fixtureReady && document.querySelector('[data-testid="lazy"]'));
  if (observe) {
    const source = await readFile(join(extension, 'entrypoints/bridge.content.js'), 'utf8');
    const bridge = await build({
      stdin: { contents: 'const defineContentScript = x => x;\n' + source.replace('export default', 'const fixtureBridge =') + '\nfixtureBridge.main();', resolveDir: join(extension, 'entrypoints') },
      bundle: true, write: false, format: 'iife',
    });
    await page.addScriptTag({ content: bridge.outputFiles[0].text });
  } else {
    await page.waitForFunction(() => window.__vibeAnnotations);
  }
  await page.addScriptTag({ content: contextBundle.outputFiles[0].text });
  const observeSelector = async selector => page.evaluate(async selector => {
    const el = document.querySelector(selector);
    const ng = window.ng;
    const owner = ng.getOwningComponent(el);
    const hosted = ng.getComponent(el);
    const chain = [], seen = new Set();
    let current = owner || hosted, stop;
    while (current && chain.length < 20) {
      if (seen.has(current)) { stop = 'cycle'; break; }
      seen.add(current);
      const host = ng.getHostElement(current);
      chain.push({ name: current.constructor.name, host: host.tagName.toLowerCase() });
      const parent = ng.getOwningComponent(host);
      if (!parent) { stop = 'no_owner'; break; }
      if (parent === current) { stop = 'self_owner'; break; }
      current = parent;
    }
    return { selector, owner: owner?.constructor.name || null, hosted: hosted?.constructor.name || null, chain: chain.reverse(), stop, metadata: owner ? ng.getDirectiveMetadata(owner) : null, context: await window.collectContext(el) };
  }, selector);
  const results = [];
  for (const selector of ['fixture-root', 'fixture-card', '[data-testid="card-action"]', '[data-testid="conditional"]', '[data-testid="repeated"]', '[data-testid="projected"]', '[data-testid="recursive-2"]', '[data-testid="same-a"]', '[data-testid="same-b"]', '[data-testid="lazy"]']) results.push(await observeSelector(selector));
  for (const kind of ['plain', 'vcr', 'template']) {
    await page.evaluate(kind => window.fixture.open(kind), kind);
    const selector = kind === 'template' ? '[data-testid="template-dialog"]' : '[data-testid="dialog-action"]';
    await page.waitForSelector(selector);
    results.push({ kind, ...await observeSelector(selector) });
    if (kind === 'plain') {
      await page.evaluate(() => window.ng.getOwningComponent(document.querySelector('[data-testid="dialog-action"]')).openNested());
      await page.waitForSelector('[data-testid="nested-dialog"]');
      results.push({ kind: 'nested', ...await observeSelector('[data-testid="nested-dialog"]') });
    }
    await page.evaluate(() => window.fixture.dialog.closeAll());
    await page.waitForSelector(selector, { state: 'detached' });
  }
  for (const kind of ['component', 'template', 'anchored-template']) {
    await page.evaluate(kind => { window.portalRef = window.fixture.portal(kind); }, kind);
    const selector = `[data-testid="${kind === 'component' ? 'component' : 'template'}-portal"]`;
    await page.waitForSelector(selector);
    results.push({ kind: kind + '-portal', ...await observeSelector(selector) });
    await page.evaluate(() => window.portalRef.dispose());
  }
  console.log(JSON.stringify({ angular: require('@angular/core/package.json').version, material: require('@angular/material/package.json').version, chromium: observe ? browser.version() : browser.browser().version(), inputReads: await page.evaluate(() => window.inputReads) }));
  console.table(results.map(r => ({ target: r.kind || r.selector, owner: r.owner, hosted: r.hosted, chain: r.chain.map(c => c.name).join(' > '), stop: r.context.source_mapping.angular?.chain?.stop_reason || r.stop, matches: r.context.target_identity?.match_count, locator_reason: r.context.target_identity?.relative_selector_reason })));
  if (!observe) {
    await verify(page, results);
    await verifyEdges(page);
    const shadow = await page.evaluate(async () => {
      const root = document.querySelector('fixture-shadow').shadowRoot;
      const context = await window.collectContext(root.querySelectorAll('button')[1]);
      return { context, resolves: root.querySelector(context.target_identity.relative_selector) === root.querySelectorAll('button')[1] };
    });
    assert.equal(shadow.context.source_mapping.angular.template_owner.name, 'ShadowComponent');
    assert.equal(shadow.context.target_identity.match_scope, 'owner_shadow_root');
    assert.equal(shadow.context.target_identity.match_count, 1);
    assert.equal(shadow.resolves, true);
    assert.ok(shadow.context.selector.includes(' >> '));
    console.log('PASS: real Angular ShadowDom owner, structural locator and shadow-aware document selector');
    await verifyPersistence(page, browser);
    await verifyOMPCopy(page, browser, origin);
    for (const path of ['/production?production', '/plain']) {
      await page.goto(origin + path);
      if (path.startsWith('/production')) await page.waitForFunction(() => window.fixtureReady);
      await page.waitForFunction(() => window.__vibeAnnotations);
      await page.addScriptTag({ content: contextBundle.outputFiles[0].text });
      const context = await page.evaluate(() => window.collectContext(document.querySelector('button')));
      assert.equal(context.source_mapping.angular, null);
      assert.equal(context.target_identity.tag, 'button');
      assert.ok(context.selector);
      assert.equal(await page.evaluate(() => typeof window.ng?.getComponent), 'undefined');
      await page.locator('.vibe-tb-annotate').click();
      await page.locator('button[data-testid]').first().click();
      const comment = `DOM fallback UI ${path}`;
      await page.locator('.vibe-textarea').fill(comment);
      await page.locator('.vibe-save-btn').click();
      await page.waitForFunction(async comment => (await window.__vibeAnnotations.getAnnotations()).some(a => a.comment === comment), comment);
      const worker = browser.serviceWorkers()[0];
      const saved = await worker.evaluate(async comment => ((await chrome.storage.local.get('annotations')).annotations || []).find(a => a.comment === comment), comment);
      assert.ok(saved, `DOM fallback Save must persist ${comment}`);
      assert.equal(saved.url, page.url(), 'fallback annotation belongs to the current page');
      assert.ok(saved.element_context.angular == null, 'DOM fallback must not invent Angular context');
      assert.equal(saved.element_context.target_identity.tag, 'button');
      assert.ok(saved.selector);
      await page.locator('.vibe-popover').waitFor({ state: 'detached' });
      await page.keyboard.press('Escape');
      await verifyDOMCopy(page, browser, origin);
    }
    console.log('PASS: optimized Angular production runtime and non-Angular DOM fallback');
  }
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
  await rm(temp, { recursive: true, force: true });
}

async function verify(page, results) {
  // Fixed owners/chains below are based on fixture sources AND the pre-change
  // experiment. TemplateRef insertion ownership is an explicit API limitation.
  const expected = [
    [null, 'AppComponent'], ['AppComponent', 'CardComponent'], ['CardComponent', null], ['CardComponent', null], ['CardComponent', null],
    ['AppComponent', null], ['RecursiveComponent', null], ['SameComponent', null], ['SameComponent', null], ['LazyComponent', null],
    ['DialogComponent', null], ['NestedDialogComponent', null], ['DialogComponent', null], ['MatDialogContainer', null], ['PortalComponent', null], [null, null], ['AppComponent', null]
  ];
  const expectedChains = [
    ['AppComponent'], ['AppComponent'], ['AppComponent', 'CardComponent'], ['AppComponent', 'CardComponent'], ['AppComponent', 'CardComponent'],
    ['AppComponent'], ['AppComponent', 'RecursiveComponent', 'RecursiveComponent', 'RecursiveComponent'],
    ['AppComponent', 'SameComponent'], ['AppComponent', 'SameComponent'], ['LazyComponent'],
    ['DialogComponent'], ['NestedDialogComponent'], ['DialogComponent'], ['MatDialogContainer'], ['PortalComponent'], [], ['AppComponent']
  ];
  for (const [index, result] of results.entries()) {
    const angular = result.context.source_mapping.angular;
    assert.equal(angular.template_owner?.name || null, expected[index][0], result.selector);
    assert.equal(angular.hosted_component?.name || null, expected[index][1], result.selector);
    assert.equal(angular.chain.status, 'observed');
    assert.equal(angular.chain.stop_reason, 'no_owner');
    assert.deepEqual(angular.chain.components, expectedChains[index], result.selector);
    assert.ok(!('inputs' in angular));
    assert.equal(result.context.source_mapping.source_file_path, null);
    assert.equal(result.context.source_mapping.url_path, '/lazy');
    assert.ok(result.context.source_mapping.context_hints.some(h => h.includes('Not proven complete')));
  }
  const card = results[2].context;
  assert.equal(card.source_mapping.angular.template_owner.host.tag, 'fixture-card');
  assert.equal(card.source_mapping.angular.change_detection, 'OnPush');
  assert.deepEqual(card.source_mapping.angular.input_names, ['publicSecret']);
  assert.ok(card.source_mapping.angular.directives.includes('MatTooltip'));
  assert.equal(results[1].context.source_mapping.angular.change_detection, 'Default');
  assert.equal(results[5].context.source_mapping.angular.template_owner.host.tag, 'fixture-root', 'projection uses actual owner host');
  assert.equal(results[4].context.target_identity.match_count, 2, 'repeated test IDs remain visibly ambiguous');
  assert.equal(results[16].context.target_identity.relative_selector_reason, 'outside_owner_host');
  assert.equal(results[7].context.source_mapping.angular.template_owner.host.tag, 'fixture-same-a');
  assert.equal(results[8].context.source_mapping.angular.template_owner.host.tag, 'fixture-same-b');
  assert.equal(await page.evaluate(() => window.inputReads), 0, 'input getters must never run');
  console.log('PASS: real Angular owners, recursive instance chain, projection, dialogs/portals, metadata privacy, locator ambiguity');
}

async function verifyEdges(page) {
  const cases = await page.evaluate(async () => {
    const original = window.ng;
    const el = document.querySelector('fixture-card');
    const collect = () => window.collectContext(el);
    const results = {};
    try {
      for (const key of ['missingOwner', 'missingHost', 'throwOwner', 'throwMetadata']) {
        window.ng = { ...original };
        const api = key === 'missingHost' ? 'getHostElement' : key === 'throwMetadata' ? 'getDirectiveMetadata' : 'getOwningComponent';
        window.ng[api] = key.startsWith('missing') ? undefined : () => { throw new Error('Fixture failure'); };
        results[key] = await collect();
      }
      for (const [key, size] of [['self', 1], ['cycle', 2], ['depth', 21], ['minified', 2]]) {
        class EdgeComponent {}
        class a {}
        const instances = Array.from({ length: size }, (_, i) => key === 'minified' && i === 0 ? new a() : new EdgeComponent());
        const hosts = instances.map(() => document.createElement('fixture-edge'));
        window.ng = {
          getComponent: () => null, getDirectives: () => [],
          getOwningComponent: node => node === el ? instances[0] : instances[(hosts.indexOf(node) + 1) % size],
          getHostElement: instance => hosts[instances.indexOf(instance)],
          getDirectiveMetadata: () => ({ inputs: {}, changeDetection: 9 }),
        };
        results[key] = await collect();
      }
      window.ng = undefined;
      results.absent = await collect();
      window.ng = original;
      const button = document.querySelector('[data-testid="card-action"]');
      const previous = button.getAttribute('data-testid');
      button.setAttribute('data-testid', 'quoted"\\] identity');
      button.setAttribute('value', 'SECRET_VALUE');
      button.setAttribute('data-private', 'SECRET_ATTRIBUTE');
      results.escaped = await window.collectContext(button);
      const identity = results.escaped.target_identity;
      results.escapedResolves = document.querySelector('fixture-card').querySelector(identity.relative_selector) === button;
      button.setAttribute('data-testid', previous);
      button.removeAttribute('value');
      button.removeAttribute('data-private');
    } finally { window.ng = original; }
    return results;
  });
  for (const [key, stop] of [['missingOwner', 'api_unavailable'], ['missingHost', 'api_unavailable'], ['throwOwner', 'api_error'], ['self', 'self_owner'], ['cycle', 'cycle'], ['depth', 'depth_limit']]) {
    assert.equal(cases[key].source_mapping.angular.chain.stop_reason, stop, key);
    assert.ok(cases[key].selector, key);
  }
  assert.equal(cases.throwOwner.source_mapping.angular.hosted_component.name, 'CardComponent');
  assert.equal(cases.throwMetadata.source_mapping.angular.template_owner.name, 'AppComponent');
  assert.equal(cases.depth.source_mapping.angular.chain.instance_count, 20);
  assert.equal(cases.minified.source_mapping.angular.chain.instance_count, 2);
  assert.equal(cases.minified.source_mapping.angular.chain.unnamed_count, 1);
  assert.equal(cases.minified.source_mapping.angular.change_detection, undefined);
  assert.equal(cases.absent.source_mapping.angular, null);
  assert.equal(cases.absent.target_identity.tag, 'fixture-card');
  assert.equal(cases.escapedResolves, true);
  assert.equal(cases.escaped.target_identity.attributes.value, undefined);
  assert.equal(cases.escaped.target_identity.attributes['data-private'], undefined);
  console.log('PASS: partial/absent/error API, cycle/self/depth, minified instances, escaped locator, attribute allowlist');
}

async function verifyPersistence(page, context) {
  await page.evaluate(() => window.__vibeAnnotations.createAnnotation('[data-testid="card-action"]', { comment: 'Angular runtime ownership check' }));
  const worker = context.serviceWorkers()[0];
  const annotations = await worker.evaluate(async () => (await chrome.storage.local.get('annotations')).annotations);
  const annotation = annotations.find(a => a.comment === 'Angular runtime ownership check');
  assert.equal(annotation.framework, 'angular');
  assert.equal(annotation.element_context.angular.template_owner.name, 'CardComponent');
  assert.equal(annotation.element_context.target_identity.relative_selector, '[data-testid="card-action"]');
  assert.equal(annotation.url_path, '/lazy');
  assert.ok(annotation.url.includes('?private=query#private'), 'internal addressing is preserved');
  assert.ok(!JSON.stringify(annotation).includes('DO_NOT_COLLECT'));
  const read = await page.evaluate(() => window.__vibeAnnotations.getAnnotations());
  assert.equal(read.find(a => a.id === annotation.id).framework, 'angular');
  assert.equal(read.find(a => a.id === annotation.id).element_context.angular.chain.stop_reason, 'no_owner');
  console.log('PASS: public create/get bridge → isolated context → real chrome.storage annotation; internal URL preserved');
  // Exercise the other annotation constructor through the actual existing UI.
  await page.locator('.vibe-tb-annotate').click();
  await page.locator('[data-testid="conditional"]').click();
  await page.locator('.vibe-textarea').fill('Angular UI context check');
  await page.locator('.vibe-save-btn').click();
  await page.waitForFunction(async () => (await window.__vibeAnnotations.getAnnotations()).some(a => a.comment === 'Angular UI context check'));
  const uiAnnotations = await worker.evaluate(async () => (await chrome.storage.local.get('annotations')).annotations);
  const ui = uiAnnotations.find(a => a.comment === 'Angular UI context check');
  assert.equal(ui.framework, 'angular');
  assert.equal(ui.element_context.angular.template_owner.name, 'CardComponent');
  assert.equal(ui.element_context.target_identity.relative_selector, '[data-testid="conditional"]');
  console.log('PASS: actual Annotate → element selection → popover comment → Save → structured Angular storage');
  // Cross the actual review/download boundary with context produced by Angular,
  // not the hand-seeded privacy fixture in local-export-runtime.mjs.
  await page.locator('.vibe-popover').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await page.locator('.vibe-tb-viewall').click();
  await page.locator('.vibe-viewall-export').click();
  await page.locator('.vibe-share-opt').click();
  await page.locator('.vibe-export-review').waitFor();
  const downloadReady = page.waitForEvent('download');
  await page.locator('[data-action="continue"]').click();
  const archive = await (await downloadReady).path();
  const exported = JSON.parse(execFileSync('unzip', ['-p', archive, 'annotations.json'], { encoding: 'utf8' }));
  const exportedUI = exported.annotations.find(a => a.id === ui.id);
  assert.equal(exportedUI.element_context.angular.template_owner.name, 'CardComponent');
  assert.equal(exportedUI.element_context.angular.template_owner.host.tag, 'fixture-card');
  assert.deepEqual(exportedUI.element_context.angular.chain.components, ['AppComponent', 'CardComponent']);
  assert.equal(exportedUI.element_context.angular.chain.status, 'observed');
  assert.equal(exportedUI.element_context.angular.chain.stop_reason, 'no_owner');
  assert.equal(exportedUI.element_context.target_identity.match_count, 1);
  assert.equal(await page.evaluate(identity => {
    const ownerHost = document.querySelector('fixture-card');
    return ownerHost.querySelector(identity.relative_selector) === document.querySelector('[data-testid="conditional"]');
  }, exportedUI.element_context.target_identity), true, 'exported owner-relative locator finds the selected template node');
  const markdown = execFileSync('unzip', ['-p', archive, 'annotations.md'], { encoding: 'utf8' });
  assert.match(markdown, /CardComponent/);
  assert.match(markdown, /conditional/);
  assert.doesNotMatch(JSON.stringify(exported) + markdown, /private=query|#private|DO_NOT_COLLECT/);
  assert.equal(await page.evaluate(() => window.inputReads), 0);
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('annotations')).annotations)).find(a => a.id === ui.id).url, ui.url);
  console.log('PASS: actual Angular Save → review → ZIP JSON/Markdown → owner-relative selected node; no input values or URL secrets');
}

async function copyOMP(page, context, origin, selectedComments = null) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.bringToFront();
  // View-all may already be open after export.
  if (!await page.locator('.vibe-viewall-copy').isVisible()) await page.locator('.vibe-tb-viewall').click();
  await page.locator('.vibe-viewall-copy').click();
  await page.locator('[data-copy-format]').selectOption('omp');
  if (selectedComments) {
    for (const row of await page.locator('.vibe-export-item').all()) {
      if (!selectedComments.includes(await row.locator('.vibe-export-row strong').innerText())) await row.locator('[data-id]').uncheck();
    }
  }
  await page.locator('[data-action="continue"]').click();
  await page.locator('.vibe-export-review').waitFor({ state: 'detached' });
  return page.evaluate(() => navigator.clipboard.readText());
}

async function verifyOMPCopy(page, context, origin) {
  const worker = context.serviceWorkers()[0];
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), 'ng-vibe-remarker');
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().action.default_title), 'ng-vibe-remarker');
  assert.equal(await page.locator('.vibe-toolbar-logo').getAttribute('title'), 'ng-vibe-remarker');
  assert.equal(await page.locator('.vibe-toolbar-logo').evaluate(img => img.complete && img.naturalWidth > 0), true);
  const manager = await context.newPage();
  await manager.goto('chrome://extensions');
  await manager.locator('extensions-item').filter({hasText:'ng-vibe-remarker'}).waitFor();
  await manager.close();
  await page.bringToFront();
  const create = (selector, comment) => page.evaluate(({selector, comment}) => window.__vibeAnnotations.createAnnotation(selector, { comment }), {selector, comment});
  for (const [selector, comment] of [['fixture-card','OMP component host'], ['[data-testid="same-a"]','OMP same A'], ['[data-testid="same-b"]','OMP same B']]) await create(selector, comment);
  await page.evaluate(() => window.fixture.open('plain'));
  await page.waitForSelector('[data-testid="dialog-action"]');
  await create('[data-testid="dialog-action"]', 'OMP component dialog');
  await page.evaluate(() => window.fixture.dialog.closeAll());
  await page.waitForSelector('[data-testid="dialog-action"]', {state:'detached'});
  await page.evaluate(() => window.fixture.open('template'));
  await page.waitForSelector('[data-testid="template-dialog"]');
  await create('[data-testid="template-dialog"]', 'OMP limited template dialog');
  await page.evaluate(() => window.fixture.dialog.closeAll());
  await page.waitForSelector('[data-testid="template-dialog"]', {state:'detached'});
  await page.evaluate(() => { window.portalRef = window.fixture.portal('template'); });
  await page.waitForSelector('[data-testid="template-portal"]');
  await create('[data-testid="template-portal"]', 'OMP limited portal');
  await page.evaluate(() => window.portalRef.dispose());
  const single = await copyOMP(page, context, origin, ['Angular UI context check']);
  assert.match(single, /CardComponent/);
  assert.match(single, /conditional/);
  assert.match(single, /match_scope: owner_host/);
  assert.match(single, /match_count: 1/);
  assert.doesNotMatch(single, /OMP same|private=query|#private|DO_NOT_COLLECT|@file/);
  const copied = await copyOMP(page, context, origin);
  if (process.env.OMP_CLIPBOARD_PATH) await writeFile(process.env.OMP_CLIPBOARD_PATH, copied);
  const blocks = copied.split(/\n\n---\n\n/);
  const block = comment => blocks.find(b => b.includes(`Change: ${comment}\n`));
  assert.match(block('OMP component host'), /Template owner: .*AppComponent/);
  assert.match(block('OMP component host'), /Hosted component: .*CardComponent/);
  for (const [comment, host, test] of [['OMP same A','fixture-same-a','same-a'], ['OMP same B','fixture-same-b','same-b']]) {
    const owner = JSON.parse(block(comment).match(/^Template owner: (.+)$/m)[1]);
    assert.equal(owner.name, 'SameComponent');
    assert.equal(owner.host.tag, host);
    assert.match(block(comment), new RegExp(test));
  }
  assert.match(block('OMP component dialog'), /Template owner: .*DialogComponent/);
  assert.match(block('OMP limited template dialog'), /Template owner: .*MatDialogContainer/);
  assert.match(block('OMP limited template dialog'), /limitations/);
  assert.doesNotMatch(block('OMP limited portal'), /Template owner:|AppComponent/);
  assert.match(block('OMP limited portal'), /template-portal/);
  // Search independently authored source declarations from copied keys, not
  // from stored annotation metadata; resolve the actual template node.
  const declarations = [];
  for (const file of ['main.js', 'same-a.js', 'same-b.js', 'lazy.js']) {
    const source = await readFile(join(here, file), 'utf8');
    for (const match of source.matchAll(/Component\(\{([\s\S]*?)\}\)\((\w+)\);/g)) {
      declarations.push({file, owner: match[2], metadata: match[1]});
    }
  }
  for (const [comment, file, owner, node] of [
    ['Angular UI context check','main.js','CardComponent','data-testid="conditional"'],
    ['OMP component host','main.js','AppComponent','<fixture-card class="user-card">'],
    ['OMP same A','same-a.js','SameComponent','data-testid="same-a"'],
    ['OMP same B','same-b.js','SameComponent','data-testid="same-b"'],
    ['OMP component dialog','main.js','DialogComponent','data-testid="dialog-action"'],
    ['OMP limited template dialog','main.js','AppComponent','data-testid="template-dialog"'],
    ['OMP limited portal','main.js','AppComponent','data-testid="template-portal"'],
  ]) {
    const pasted = block(comment);
    const target = JSON.parse(pasted.match(/^Target: (.+)$/m)[1]);
    const observedOwner = pasted.match(/^Template owner: (.+)$/m);
    const observed = observedOwner ? JSON.parse(observedOwner[1]) : null;
    const testId = target.attributes?.['data-testid'];
    const needle = testId ? `data-testid="${testId}"` : `<${target.tag}`;
    let found = declarations.filter(d => d.metadata.includes(needle));
    if (observed?.name && observed.name !== 'MatDialogContainer') {
      found = found.filter(d => d.owner === observed.name && (!observed.host?.tag || new RegExp(`selector:\\s*['"]${observed.host.tag}['"]`).test(d.metadata)));
    }
    assert.equal(found.length, 1, `${comment}: copied keys resolve one source declaration`);
    assert.equal(found[0].file, file);
    assert.equal(found[0].owner, owner);
    assert.ok(found[0].metadata.includes(node), `${comment}: resolved template contains the exact selected node`);
    console.log(`FOUND from OMP clipboard: ${comment} → ${found[0].file} / ${found[0].owner} / ${node}`);
  }
  assert.equal(await page.evaluate(() => window.inputReads), 0);
  console.log('PASS: installed name/logo, single/multiple real Angular OMP clipboard and source template search');
}

async function verifyDOMCopy(page, context, origin) {
  const text = await copyOMP(page, context, origin, [`DOM fallback UI ${new URL(page.url()).pathname === '/plain' ? '/plain' : '/production?production'}`]);
  assert.match(text, /Target: .*button/);
  assert.match(text, /no template owner is confirmed/);
  assert.doesNotMatch(text, /Template owner:|Hosted component:|Observed owner chain:|@file/);
  assert.ok(text.includes(new URL(page.url()).pathname));
  console.log('PASS: real DOM/optimized JIT clipboard without invented Angular owner');
}
