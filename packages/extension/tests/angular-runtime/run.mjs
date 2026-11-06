import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

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
    await page.addScriptTag({ content: 'const defineContentScript = x => x;\n' + source.replace('export default', 'window.fixtureBridge =') + '\nwindow.fixtureBridge.main();' });
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
}
