import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(join(process.env.ANGULAR_DEPS || '/tmp/va-stage1-ng20', 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ stdin: { resolveDir: extension, contents: "export { default } from './lib/content/element-context.js'; export { renderAnnotationsForOMP } from './lib/content/export-omp.js';" }, bundle: true, write: false, format: 'iife', globalName: 'Context', define: { 'import.meta.env': '{"DEV":true}' } });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  const hopErrors = [];
  page.on('console', message => {
    if (message.type() === 'assert' && message.text().includes('Remarker: invalid DOM hop count')) hopErrors.push(message.text());
  });
  await page.setContent(`<main id="login"><form id="target"><label>Учетная запись</label><label>Пароль</label><span aria-hidden="true">visibility</span><label>Идентификатор ВКЦ</label><input value="PRIVATE_INPUT"><script type="application/json">PRIVATE_SCRIPT</script><button id="undefined" aria-disabled="false" style="opacity:0.5"><span translate="AUTH.LOGIN.SUBMIT">Войти в систему</span></button></form></main>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const element = document.querySelector('#target');
    let valueReads = 0;
    Object.defineProperty(document.querySelector('input'), 'value', { get() { valueReads++; return 'PRIVATE_INPUT'; } });
    const context = await Context.default.generate(element);
    const button = await Context.default.generate(element.querySelector('button'));
    const note = { selector: '#target', element_context: context };
    const direct = Context.default.findElementBySelector(note) === element;
    element.id = 'moved';
    const fallback = Context.default.findElementBySelector(note) === element;
    const legacy = Context.default.findElementBySelector({ selector: '#moved', element_context: { text: element.textContent.substring(0, 100).trim() } }) === element;
    element.append(document.createTextNode(' Extra context '.repeat(20)));
    const long = await Context.default.generate(element);
    return { context, button, direct, fallback, legacy, longText: long.text, valueReads };
  });
  assert.equal(result.context.text, 'Учетная запись Пароль Идентификатор ВКЦ Войти в систему');
  assert.doesNotMatch(JSON.stringify(result.context), /PRIVATE_INPUT|PRIVATE_SCRIPT/);
  assert.deepEqual(result.button.state, { disabled: false, 'aria-disabled': 'false', visible: true });
  assert.equal(result.button.styles.opacity, '0.5');
  assert.equal(result.button.translation_key, 'AUTH.LOGIN.SUBMIT');
  assert.doesNotMatch(result.button.selector, /#undefined/);
  assert.equal(result.valueReads, 0);
  assert.equal(result.direct, true);
  assert.equal(result.fallback, true);
  assert.equal(result.legacy, true);
  assert.ok(result.longText.length <= 100);
  assert.ok(result.longText.endsWith('…'));
  const handoff = await page.evaluate(async () => {
    document.body.innerHTML = `<main data-testid="workspace-root" data-workspace-id="desk" data-preset-id="support">
      <awp-aaa-manager-widget data-widget-id="aaa-2" data-testid="aaa-manager-widget">
        <div data-testid="aaa-manager-tabs">
          <div id="role-tab" role="tab" data-tab-index="CATEGORY_UNIONS" data-remarker-guard="@if (externalUsersMode)">
            <div class="mdc-tab" data-testid="unions-tab"><span id="tab-label" data-testid="tab-label" class="mdc-tab__text-label awp-tab-label awp-label extra" translate="WIDGET.TAB.UNIONS">Объединение</span></div>
          </div>
        </div>
        <awp-new-table data-testid="types-table"><mat-table role="table">
          <mat-row role="row"><mat-cell class="cdk-column-name">Another type</mat-cell><mat-cell><button>Открыть</button></mat-cell></mat-row>
          <mat-row role="row"><mat-cell class="cdk-column-name">Queue type</mat-cell><mat-cell id="actions-cell" role="cell" class="mat-column-rendered-alias" data-column-field="field-alias" awpTableCell="actions"><awp-table-actions id="row-action">Открыть</awp-table-actions></mat-cell></mat-row>
        </mat-table></awp-new-table>
      </awp-aaa-manager-widget>
    </main>
    <button class="btn awp-main-header-button mat-mdc-menu-trigger awp-work-state-button" data-remarker-guard="@else of isAwaitingState">Доступен <span class="awp-work-state-duration" style="opacity:.5;cursor:crosshair">00:38:56</span></button>
    <div class="input row col awp-main-header-button">Несвязанный узел</div>`;
    const nativeTable = document.createElement('table');
    nativeTable.setAttribute('mat-table', '');
    nativeTable.dataset.testid = 'new-table';
    const nativeRow = document.createElement('tr');
    nativeRow.setAttribute('mat-row', '');
    nativeRow.dataset.testid = 'native-row';
    const nativeCell = document.createElement('td');
    nativeCell.setAttribute('mat-cell', '');
    nativeCell.id = 'native-cell';
    nativeRow.append(nativeCell);
    nativeTable.append(nativeRow);
    const wrappers = document.createElement('div');
    wrappers.dataset.testid = 'aaa-widget-types-data-table';
    wrappers.innerHTML = '<awp-hiding-panel><section><div><awp-new-table></awp-new-table></div></section></awp-hiding-panel>';
    wrappers.querySelector('awp-new-table').append(nativeTable);
    document.body.append(wrappers);
    const capture = (selector, comment) => Context.default.generate(document.querySelector(selector)).then(element_context => ({ id: selector, comment, element_context }));
    const notes = await Promise.all([
      capture('#tab-label', 'Вкладка'),
      capture('#role-tab', 'Роль вкладки'),
      capture('#row-action', 'Кнопки'),
      capture('#actions-cell', 'Ячейка'),
      capture('#native-cell', 'Нативная ячейка'),
      capture('.awp-work-state-duration', 'Таймер\nКонтекст: заголовок рабочего пространства'),
      capture('.awp-work-state-button', 'Кнопка с таймером'),
      capture('.input', 'Узел без классов приложения'),
    ]);
    const [,, actions] = notes;
    actions.element_context.handoff.test_anchors.push({ value: 'known-anchor' });
    const legacy = { id: 'vibe_legacy', element_context: { tag: 'span' }, parent_chain: [{ id: 'legacy-parent' }] };
    return Context.renderAnnotationsForOMP([...notes, legacy]);
  });
  const [tab, promoted, row, cell, nativeCell, timer, button, common, legacyBlock] = handoff.split('\n\n---\n\n');
  assert.match(tab, /^Anchor chain: data-testid="tab-label" \(0 up\) → data-testid="unions-tab" \(1 up\) → data-testid="aaa-manager-tabs" \(3 up\) → data-testid="aaa-manager-widget" \(4 up\)$/m);
  assert.match(tab, /^Interactive ancestor: div\[role="tab"\] \(2 up\)$/m);
  assert.match(tab, /^Text: <static: i18n>$/m);
  assert.match(promoted, /^Target: div$/m);
  assert.match(promoted, /^Label: Объединение$/m);
  assert.match(promoted, /^Label key: WIDGET\.TAB\.UNIONS$/m);
  assert.match(promoted, /^Label source: span\.awp-tab-label\.awp-label · data-testid="tab-label" · data-testid="unions-tab" \(descendant\)$/m);
  assert.match(promoted, /^Anchor chain: data-testid="aaa-manager-tabs" \(1 up\) → data-testid="aaa-manager-widget" \(2 up\)$/m);
  assert.match(tab, /^Target: span\.awp-tab-label\.awp-label · translate="WIDGET.TAB.UNIONS"$/m);
  assert.match(tab, /^Guard: @if \(externalUsersMode\)$/m);
  assert.match(tab, /^Context: .*data-workspace-id="desk"; data-preset-id="support"; data-widget-id="aaa-2"; tab "CATEGORY_UNIONS"$/m);
  assert.match(tab, /^State: default$/m);
  assert.match(row, /^Anchor chain \(from cell\): data-testid="types-table" \(3 up\) → data-testid="aaa-manager-widget" \(4 up\) → data-testid="known-anchor" \(unverified\)$/m);
  assert.match(legacyBlock, /^## A-vibe_legacy$/m);
  assert.match(legacyBlock, /^Anchor chain: id="legacy-parent" \(unverified\)$/m);
  assert.match(row, /^Interactive ancestor: mat-cell\[role="cell"\] \(1 up\)$/m);
  assert.match(row, /^Row: "Queue type"$/m);
  assert.match(row, /^Cell column: actions \(via awpTableCell; mat-column-rendered-alias\)$/m);
  assert.match(cell, /^Projected: awp-table-actions \(awpTableCell="actions"\)$/m);
  assert.doesNotMatch(row, /^Projected:|^Attrs:.*(?:role|awpTableCell)|column="actions"|Another type|Открыть|workspace-root/m);
  assert.match(nativeCell, /^Anchor chain: data-testid="native-row" \(1 up\) → data-testid="new-table" \(2 up\) → data-testid="aaa-widget-types-data-table" \(7 up\)$/m);
  assert.deepEqual(hopErrors, []);
  assert.match(timer, /^Anchor chain: none$/m);
  assert.match(timer, /^Interactive ancestor: button \(1 up\) · matMenuTriggerFor \(binding name only\)$/m);
  assert.match(timer, /^Guard: @else of isAwaitingState$/m);
  assert.match(timer, /^Target: span\.awp-work-state-duration$/m);
  assert.match(timer, /^Text: <dynamic: timer>$/m);
  assert.doesNotMatch(timer, /^Inner:/m);
  assert.match(button, /^Target: button\.awp-work-state-button$/m);
  assert.match(button, /^Attrs: matMenuTriggerFor \(binding name only\)$/m);
  assert.match(button, /^Inner: span\.awp-work-state-duration \(1 down\)$/m);
  assert.match(button, /^Text: <dynamic: timer>$/m);
  assert.match(common, /^Target: div\.awp-main-header-button$/m);
  assert.match(timer, /^State: opacity:0\.5$/m);
  assert.doesNotMatch(tab, /Объединение/);
  assert.doesNotMatch(handoff, /mdc-|crosshair|00:38:56/);
  const overlayNotes = await page.evaluate(async () => {
    document.body.innerHTML = '<button data-testid="covered-target" style="position:fixed;left:30px;top:30px;width:100px;height:40px">Target</button>';
    const target = document.querySelector('[data-testid="covered-target"]');
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2;pointer-events:auto';
    overlay.append(document.createElement('span'));
    document.body.append(overlay);
    overlay.className = 'table__rows-loader';
    overlay.setAttribute('data-remarker-overlay-condition', 'isLoadingData()');
    const loading = await Context.default.generate(target);
    overlay.removeAttribute('data-remarker-overlay-condition');
    const unlabelled = await Context.default.generate(target);
    overlay.className = 'cdk-overlay-backdrop';
    overlay.style.zIndex = 'auto';
    const modal = await Context.default.generate(target);
    overlay.className = '';
    overlay.setAttribute('popover', 'manual');
    overlay.style.cssText += ';margin:0;width:100%;height:100%;max-width:none;max-height:none';
    overlay.showPopover();
    const popover = await Context.default.generate(target);
    overlay.remove();
    const clear = await Context.default.generate(target);
    return Context.renderAnnotationsForOMP([loading, unlabelled, modal, popover, clear].map((element_context, id) => ({ id, element_context })));
  });
  const [loading, unlabelled, modal, popover, clear] = overlayNotes.split('\n\n---\n\n');
  assert.match(loading, /^State: covered-by-overlay \(transient; div\.table__rows-loader while isLoadingData\(\), z-index 2; sampled at capture\)$/m);
  assert.match(unlabelled, /^State: covered-by-overlay \(transient; div\.table__rows-loader, z-index 2; sampled at capture\)$/m);
  assert.match(modal, /^State: covered-by-overlay \(sticky; div\.cdk-overlay-backdrop\)$/m);
  assert.match(popover, /^State: covered-by-overlay \(unidentified\)$/m);
  assert.match(clear, /^State: default$/m);
  for (const block of [loading, unlabelled, modal, popover, clear]) {
    assert.match(block, /^Target: button$/m);
    assert.match(block, /^Anchor chain: data-testid="covered-target" \(0 up\)$/m);
  }
  console.log('PASS DOM handoff: identity, dynamic timer, loader and modal causes, capture-time snapshot');
} finally {
  await browser.close();
}
