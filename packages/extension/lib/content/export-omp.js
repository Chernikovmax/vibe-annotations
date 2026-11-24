// Plain text for manual pasting, not an OMP transport or source-location protocol.
const frameworkClass = /^(?:_?mat-|mdc-|cdk-|_?ng-|vibe-)/i;
const genericClass = /^(?:btn(?:-|$)|input(?:-|$)|row$|col(?:-|$))/i;
const frameworkOwner = /^(?:_?Mat|_?Cdk)[A-Z]/;

function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function token(key, value) {
  return key + '=' + JSON.stringify(inline(value));
}

function idValue(value) {
  return value && !frameworkClass.test(value) && !/^(?:undefined|null)$/i.test(value) ? value : '';
}

function renderOwners(ng, outletTarget, binding) {
  const tags = ng.chain?.hosts || {};
  const owners = [];
  const add = (name, tag, endpoint = false) => {
    if (!name || frameworkOwner.test(name) || frameworkClass.test(tag || '')) return;
    const last = owners.at(-1);
    if (endpoint && last?.name === name && (!last.tag || !tag || last.tag === tag)) last.tag ||= tag;
    else owners.push({ name, tag });
  };
  for (const name of ng.chain?.components || []) add(name, Object.hasOwn(tags, name) ? tags[name] : undefined);
  add(ng.template_owner?.name, ng.template_owner?.host?.tag, true);
  add(ng.hosted_component?.name, ng.hosted_component?.host?.tag, true);
  const format = ({ name, tag }) => tag ? name + ' (' + tag + ')' : name;
  const { declared_by: declared, renderer, projected, cell } = ng.projection || {};
  if (declared?.name && renderer?.name) {
    const end = owners.findLastIndex(({ name, tag }) => name === declared.name && (!tag || tag === declared.host?.tag));
    const prefix = end < 0 ? format({ name: declared.name, tag: declared.host?.tag }) : owners.slice(0, end + 1).map(format).join(' → ');
    if (outletTarget || cell && projected?.name) {
      const outlet = renderer.name + ' (' + [renderer.host?.tag, binding ? 'renders the awpTableCell outlet' : 'renders the outlet'].filter(Boolean).join('; ') + ')';
      const content = projected?.name && projected.name + ' (' + [projected.host?.tag, cell ? 'projected cell template' : 'projected content'].filter(Boolean).join('; ') + ')';
      return prefix + ' → ' + outlet + (content ? ' ⇢ ' + content : '');
    }
    if (projected?.name) {
      const start = owners.findIndex(({ name, tag }, index) => index > end && name === projected.name && (!tag || tag === projected.host?.tag));
      const component = start < 0 ? format({ name: projected.name, tag: projected.host?.tag }) : owners.slice(start).map(format).join(' → ');
      return prefix + ' → ' + component;
    }
  }
  return owners.map(format).join(' → ');
}

function nodeSelector(tag, classes = []) {
  return inline(tag) + classes.filter(name => !frameworkClass.test(name) && !genericClass.test(name))
    .slice(0, 2).map(name => '.' + inline(name)).join('');
}

function renderLabelSource(label) {
  const source = label.source;
  const node = source?.tag && nodeSelector(source.tag, source.classes);
  const path = (label.descendant_anchors || []).map(value => token('data-testid', value));
  const origin = [node, ...path].filter(Boolean).join(' · ');
  if (label.via) return origin ? origin + ' (' + label.via + ')' : label.via;
  return origin ? origin + ' (descendant)' : '';
}

function renderOverlay(overlay) {
  if (!overlay) return '';
  const selector = inline(overlay.selector);
  if (!/\.|\[data-testid=/.test(selector)) return 'covered-by-overlay (unidentified)';
  const cause = selector + (overlay.condition ? ' while ' + inline(overlay.condition) : '')
    + (overlay.z_index != null ? ', z-index ' + inline(overlay.z_index) : '');
  const detail = [overlay.kind, cause, overlay.kind !== 'sticky' && 'sampled at capture'].filter(Boolean).join('; ');
  return 'covered-by-overlay' + (detail ? ' (' + detail + ')' : '');
}

function renderState(ec, handoff) {
  const state = ec.state || {}, style = ec.styles || {};
  return [
    (state.disabled === true || state['aria-disabled'] === 'true') && 'disabled',
    handoff.aria_hidden && 'aria-hidden',
    (handoff.hidden || (state.visible === false && !handoff.aria_hidden
      && style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility))) && 'hidden',
    style.display === 'none' && 'display:none',
    style.opacity != null && style.opacity !== '' && Number(style.opacity) < 1 && 'opacity:' + inline(style.opacity),
    style.pointerEvents === 'none' && 'pointer-events:none',
    ['hidden', 'collapse'].includes(style.visibility) && 'visibility:' + style.visibility,
    renderOverlay(handoff.covered_by_overlay),
  ].filter(Boolean).join(', ') || 'default';
}

function hops(depth, verified) {
  return (depth === 0 || verified && Number.isInteger(depth) && depth > 0) ? ' (' + depth + ' up)' : '';
}

export function renderAnnotationsForOMP(annotations) {
  const blocks = annotations.map(a => {
    const ec = a.element_context || {}, ng = ec.angular || {};
    const node = ec.target_identity || ec, attrs = node.attributes || {}, handoff = ec.handoff || {};
    const page = inline(a.url || a.url_path);
    const lines = [`## A-${inline(a.id)}${page ? ` · Page: ${page}` : ''}`];
    const add = (label, value) => { if (value) lines.push(`${label}: ${value}`); };
    const notes = { Change: [], Scenario: [], Observation: [], Guard: [], Context: [], Row: [] };
    const noteLabels = { scenario: 'Scenario', сценарий: 'Scenario', observation: 'Observation', наблюдение: 'Observation',
      guard: 'Guard', условие: 'Guard', context: 'Context', контекст: 'Context', row: 'Row', строка: 'Row' };
    let layout = false;
    for (const line of String(a.comment || '').split(/\r?\n/)) {
      const match = line.match(/^\s*(scenario|сценарий|observation|наблюдение|layout|в[её]рстка|guard|условие|context|контекст|row|строка):\s*(.*)$/i);
      if (!match) { notes.Change.push(line); continue; }
      const key = match[1].toLowerCase();
      if (['layout', 'верстка', 'вёрстка'].includes(key)) layout = true;
      notes[noteLabels[key] || 'Change'].push(match[2]);
    }
    add('Change', inline(notes.Change.join(' ')));
    if (a.type !== 'stylesheet') {
      const tag = inline(node.tag);
      const translation = attrs.translate || attrs['ng-reflect-translate'];
      const i18n = translation ? token('translate', translation)
        : attrs.awptranslatetooltip && token('awpTranslateTooltip', attrs.awptranslatetooltip);
      const ownId = idValue(attrs.id ?? (!ec.target_identity && ec.id));
      const ownTest = attrs['data-testid'];
      const verifiedHops = handoff.dom_hops === true;
      const ancestorTest = handoff.anchors?.['data-testid'];
      const ancestorId = handoff.ancestor_id || handoff.anchors?.id;
      const oldId = !ec.handoff && a.parent_chain?.find(parent => idValue(parent.id));
      const testAnchors = [ownTest && { value: ownTest, depth: 0 },
        ...(handoff.test_anchors || (ancestorTest ? [ancestorTest] : [])),
      ].filter(entry => entry?.value).slice(0, 4);
      const cell = handoff.interactive_ancestor;
      const cellOffset = verifiedHops && !ownTest && (cell?.role === 'cell' || cell?.role === 'gridcell') && cell.depth === 1
        && (handoff.cell_column || handoff.row) && testAnchors.some(entry => entry.depth > cell.depth)
        && testAnchors.every(entry => entry.depth == null || entry.depth >= cell.depth) ? cell.depth : 0;
      const anchorHops = depth => (Number.isInteger(depth) && hops(depth - cellOffset, verifiedHops)) || ' (unverified)';
      const anchor = testAnchors.length ? testAnchors.map(entry => token('data-testid', entry.value) + anchorHops(entry.depth)).join(' → ')
        : ownId ? token('id', ownId) + hops(0)
        : ancestorId?.value ? token('id', ancestorId.value) + anchorHops(ancestorId.depth)
        : oldId ? token('id', oldId.id) + ' (unverified)' : 'none';
      add(cellOffset ? 'Anchor chain (from cell)' : 'Anchor chain', anchor);
      const label = nodeSelector(tag, node.classes);
      add('Target', [label, i18n].filter(Boolean).join(' · '));
      const accessibleLabel = handoff.label || {};
      add('Label', inline(accessibleLabel.value));
      add('Label key', inline(accessibleLabel.source?.key || accessibleLabel.key));
      add('Label source', renderLabelSource(accessibleLabel));
      add('Attrs', [
        ownId && testAnchors.length && token('id', ownId),
        attrs['aria-label'] && token('aria-label', attrs['aria-label']),
        (attrs.role || (!ec.target_identity && ec.role)) && token('role', attrs.role || ec.role),
        attrs['data-tab-index'] && token('data-tab-index', attrs['data-tab-index']),
        attrs.matmenutriggerfor && token('matMenuTriggerFor', attrs.matmenutriggerfor),
        !attrs.matmenutriggerfor && (attrs['ng-reflect-mat-menu-trigger-for'] || handoff.menu_trigger || ng.directives?.includes('MatMenuTrigger'))
          && 'matMenuTriggerFor (binding name only)',
        attrs.awptablecell && token('awpTableCell', attrs.awptablecell),
      ].filter(Boolean).join('; '));
      const ancestor = handoff.interactive_ancestor;
      if (ancestor?.tag) {
        const name = ancestor.tag + (ancestor.role ? '[' + token('role', ancestor.role) + ']' : '');
        const menu = ancestor.menu ? token('matMenuTriggerFor', ancestor.menu) : ancestor.menu_binding && 'matMenuTriggerFor (binding name only)';
        add('Interactive ancestor', [name + hops(ancestor.depth, verifiedHops), menu].filter(Boolean).join(' · '));
      }
      const inner = handoff.inner;
      if (inner?.tag && Number.isInteger(inner.depth) && inner.depth > 0) {
        add('Inner', nodeSelector(inner.tag, inner.classes) + ' (' + inner.depth + ' down)');
      }
      const column = handoff.cell_column;
      if (column?.value) {
        const source = [inline(column.attribute), inline(column.class_name)].filter(Boolean).join('; ');
        add('Cell column', inline(column.value) + (source ? ' (via ' + source + ')' : ''));
      }
      const projected = handoff.projected;
      const cellTarget = ['td', 'th', 'mat-cell', 'cdk-cell', 'ng-container'].includes(tag)
        || ['cell', 'gridcell'].includes(attrs.role || (!ec.target_identity && ec.role));
      const outletTarget = ng.projection?.outlet_target ?? (cellTarget && ng.projection?.projected?.host?.tag !== tag);
      if (outletTarget && projected?.tag && projected.tag !== tag) {
        add('Projected', inline(projected.tag) + (projected.binding ? ' (' + token('awpTableCell', projected.binding) + ')' : ''));
      }
      const row = handoff.row;
      const rowIdentity = inline(notes.Row.join(' ')) || (row?.identity && JSON.stringify(inline(row.identity)));
      const tableAnchor = row?.container && !testAnchors.some(entry => entry.value === row.container) && token('data-testid', row.container);
      add('Row', [rowIdentity, tableAnchor && 'container ' + tableAnchor].filter(Boolean).join('; '));
      add('Guard', inline(notes.Guard.join(' ')) || inline(handoff.guard));
      const owners = renderOwners(ng, outletTarget, projected?.binding || column?.attribute === 'awpTableCell' || ng.projection?.outlet_binding === 'awpTableCell');
      add('Owner', owners);
      add('State', renderState(ec, handoff));
      const kind = handoff.text_kind || inner?.kind || (translation && 'i18n')
        || (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(inline(ec.text)) && 'timer') || (row && ec.text && 'row data');
      add('Text', kind === 'static' ? (inline(ec.text) && JSON.stringify(inline(ec.text)))
        : kind === 'i18n' ? '<static: i18n>'
        : ['timer', 'counter', 'date', 'row data'].includes(kind) ? '<dynamic: ' + kind + '>' : '');
      const context = handoff.context || {};
      add('Context', [
        ...['data-workspace-id', 'data-preset-id', 'data-widget-id'].map(key => context[key] && token(key, context[key])),
        inline(notes.Context.join(' ')) || inline(context['data-remarker-context']),
        context['data-tab-index'] && !attrs['data-tab-index'] && 'tab ' + JSON.stringify(inline(context['data-tab-index'])),
      ].filter(Boolean).join('; '));
      if (!ec.handoff && !translation && ec.translation_key) add('i18n hint', token('translate', ec.translation_key));
      if (!owners) add('Search hint (unconfirmed)', (a.legacy_search_hints || [])
        .map(inline).filter(hint => !frameworkOwner.test(hint.split(': ').at(-1))).join(', '));
    }
    add('Scenario', inline(notes.Scenario.join(' ')));
    add('Observation', inline(notes.Observation.join(' ')));
    const changes = Object.entries(a.pending_changes || {}).filter(([, change]) => change?.value != null);
    if (changes.length) add('Design changes', JSON.stringify(Object.fromEntries(changes.map(([key, change]) => {
      if (key === 'copyChange' && handoff.text_kind !== 'static') {
        const { original, ...requested } = change;
        return [key, requested];
      }
      return [key, change];
    }))));
    if (a.css) add('CSS', JSON.stringify(a.css));
    if (layout || a.css || changes.some(([property]) => property !== 'copyChange')) {
      const { width, height, x, y } = ec.position || {};
      if ([width, height, x, y].every(Number.isFinite)) add('Layout', `rect ${Math.round(width)}×${Math.round(height)} @ (${Math.round(x)}, ${Math.round(y)})`);
    }
    for (const attachment of a.attachments || []) {
      if (attachment.local_path) {
        add(attachment.kind === 'capture' ? 'Screenshot file' : 'Image file', JSON.stringify(attachment.local_path));
        add('Image expires', inline(attachment.expires_at));
      } else {
        add('Image unavailable', inline(attachment.unavailable_reason) || 'No local image bytes; exclude it or restore its data');
      }
    }
    if (a.attachments?.some(att => att.local_path)) lines.push('Image paths are local to this computer; remote/container agents need access to the same files.');
    if (lines.length > 12) lines.splice(11, lines.length - 11, lines.slice(11).join(' · '));
    return lines.join('\n');
  });
  const build = typeof __REMARKER_BUILD__ === 'string' ? __REMARKER_BUILD__ : '';
  return '# Remarker — manual OMP handoff\n\n' + (build ? 'Build: ' + build + '\n\n' : '') + blocks.join('\n\n---\n\n') + '\n';
}
