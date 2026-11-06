// Plain text for manual pasting, not an OMP transport or source-location protocol.
function nonempty(value) {
  if (Array.isArray(value)) {
    const items = value.map(nonempty).filter(v => v !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, nonempty(item)]).filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value == null || value === '' ? undefined : value;
}
export function renderAnnotationsForOMP(annotations) {
  const blocks = annotations.map((a, index) => {
    const lines = [`## Annotation ${index + 1}`];
    const add = (label, value) => {
      value = nonempty(value);
      if (value === undefined) return;
      lines.push(`${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    };
    add('Change', a.comment);
    add('Design changes', a.pending_changes);
    add('CSS', a.css);
    add('Page', a.url || a.url_path);
    const ec = a.element_context || {}, ng = ec.angular || {}, target = ec.target_identity || {};
    lines.push('\nObserved context:');
    add('Template owner', ng.template_owner);
    add('Hosted component', ng.hosted_component);
    const attributes = Object.fromEntries(Object.entries(target.attributes || {}).filter(([key]) => ['data-testid', 'data-test', 'data-cy', 'data-component', 'role', 'type'].includes(key)));
    add('Target', { ...(target.tag ? { tag: target.tag } : {}), ...(Object.keys(attributes).length ? { attributes } : {}), ...(target.classes?.length ? { classes: target.classes } : {}) });
    for (const key of ['relative_selector', 'match_scope', 'match_count', 'relative_selector_reason']) add(key, target[key]);
    if (!target.relative_selector) {
      add('DOM locator', a.selector?.includes('data-vibe-id') ? ec.path : a.selector);
      if (ec.path !== a.selector) add('DOM path', ec.path);
    }
    add('Observed owner chain', ng.chain);
    add('Directives', ng.directives);
    add('Legacy search hints (unconfirmed)', a.legacy_search_hints);
    add('Input names (not values)', ng.input_names);
    add('Change detection', ng.change_detection);
    lines.push('\nSearch guidance (not an observation):');
    lines.push(ng.template_owner?.name
      ? 'Start with the observed template owner name; disambiguate by host and target test attributes/classes in its template. Names may repeat; a host tag is not proof of an Angular selector.'
      : 'Search using the retained DOM tag, test attributes/classes and locator; no template owner is confirmed.');
    if (ng.chain?.limitations) lines.push('For limited dialog/portal ownership, use the DOM target to find the declaration; do not infer an opener or missing owner.');
    const remaining = { ...ec };
    for (const key of ['angular', 'target_identity', 'path']) delete remaining[key];
    // Target identity owns these keys. Never resurrect excluded identity fields
    // from the older, duplicated DOM representation.
    if (ec.target_identity) for (const key of ['tag', 'classes', 'attributes']) delete remaining[key];
    if (Object.keys(remaining).length) {
      lines.push('\nAdditional reviewed DOM context:');
      for (const [key, value] of Object.entries(remaining)) add(key, value);
    }
    add('Parent context', a.parent_chain);
    if (a.attachments?.length) lines.push('\nImages: Copied text does not transfer image bytes. Use Export ZIP, extract it into an agent-accessible directory, and provide that directory separately.');
    return lines.join('\n');
  });
  return '# ng-vibe-remarker — manual OMP handoff\n\n' + blocks.join('\n\n---\n\n') + '\n';
}
