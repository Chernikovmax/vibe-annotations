// Local export format. Attachment paths exist only inside the export archive.
function camelToKebab(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function angularHostToken(host) {
  if (!host || !host.tag) return null;
  return host.tag + (host.id ? `#${host.id}` : '') + (host.classes || []).map(c => `.${c}`).join('');
}
function cleanUrl(value) {
  if (typeof value !== 'string') return value;
  try { const u = new URL(value); u.search = ''; u.hash = ''; return u.href; } catch { return value.split(/[?#]/, 1)[0]; }
}
function removeExportField(copy, path) {
  const keys = path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  const key = keys.pop();
  let parent = copy;
  for (const part of keys) parent = parent?.[part];
  if (parent && typeof parent === 'object') delete parent[key];
}
function compactExportArrays(value) {
  if (Array.isArray(value)) return value.filter((_, index) => index in value).map(compactExportArrays);
  if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = compactExportArrays(value[key]);
  return value;
}
export function sanitizeAnnotationForExport(annotation, excluded = new Set()) {
  const copy = JSON.parse(JSON.stringify(annotation));
  delete copy.screenshot;
  delete copy.context_hints; // Legacy hints may contain serialized input values.
  delete copy.attachments;
  if (copy.url) copy.url = cleanUrl(copy.url);
  if (copy.url_path) copy.url_path = cleanUrl(copy.url_path);
  if (copy.element_context?.angular) {
    delete copy.element_context.angular.inputs;
    delete copy.element_context.angular.input_values;
    if (copy.element_context.angular.url_path) copy.element_context.angular.url_path = cleanUrl(copy.element_context.angular.url_path);
  }
  const prefix = `${copy.id}:field:`;
  for (const field of excluded) if (field.startsWith(prefix)) removeExportField(copy, field.slice(prefix.length));
  return compactExportArrays(copy);
}
export function renderAnnotationsMarkdown(annotations, host) {
  let md = `# vibe-remarker — ${host} · ${annotations.length} annotation${annotations.length === 1 ? '' : 's'}\n\nFollow my instructions on these elements. When applying design changes, map values to the project design system (Tailwind classes, CSS variables, or design tokens).\n\n---\n\n`;
  [...annotations].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).forEach((a, i) => {
    const ec = a.element_context || {}, ng = ec.angular || null;
    md += `## ${i + 1}. ${a.comment || '_(no comment)_'}\n\n`;
    if (a.type === 'stylesheet') {
      if (a.css) md += `- **CSS:**\n\`\`\`css\n${a.css}\n\`\`\`\n`;
      md += '\n'; return;
    }
    if (ng) {
      if (ng.template_owner) md += `- **Template owner:** \`${ng.template_owner.name || ''}\`${ng.template_owner.host?.tag ? ` (\`${angularHostToken(ng.template_owner.host)}\`)` : ''}\n`;
      if (ng.hosted_component) md += `- **Hosted component:** \`${ng.hosted_component.name || ''}\`${ng.hosted_component.host?.tag ? ` (\`${angularHostToken(ng.hosted_component.host)}\`)` : ''}\n`;
      if (ng.component) md += `- **Angular component:** \`${ng.component}\`\n`;
      if (ng.chain) md += `- **Observed owner chain:** ${(ng.chain.components || []).map(x => `\`${x}\``).join(' → ')} (status: ${ng.chain.status || 'unknown'}; stop: ${ng.chain.stop_reason || 'unknown'}; limitations: ${ng.chain.limitations || 'debug API may not expose declarative owners'})\n`;
      if (ng.directives?.length) md += `- **Angular directives:** ${ng.directives.map(x => `\`${x}\``).join(', ')}\n`;
      if (ng.input_names?.length) md += `- **Angular input names:** ${ng.input_names.map(x => `\`${x}\``).join(', ')}\n`;
    }
    if (ec.target_identity) md += `- **Target identity:** \`${JSON.stringify(ec.target_identity)}\`\n`;
    if (a.source_file_path) md += `- **Source:** \`${a.source_file_path}${a.source_line_range ? ` (lines ${a.source_line_range})` : ''}\`\n`;
    const url = cleanUrl(a.url || '');
    if (url) md += `- **Page:** ${url}\n`;
    if (ec.path) md += `- **DOM path:** \`${ec.path}\`\n`;
    const selector = a.selector?.includes('data-vibe-id') ? ec.path : a.selector;
    if (selector) md += `- **Selector:** \`${selector}\`\n`;
    if (ec.tag || ec.text) md += `- **Element:** \`${ec.tag || ''}\` "${truncate(ec.text, 60)}"\n`;
    const changes = Object.entries(a.pending_changes || {}).filter(([,v]) => v?.value != null).map(([p,v]) => `\`${p === 'copyChange' ? 'text' : camelToKebab(p)}\`: ${v.original ?? '—'} → **${v.variable ? `var(${v.variable})` : v.value}**`);
    if (changes.length) md += `- **Design changes:**\n${changes.map(x => `    - ${x}\n`).join('')}`;
    if (a.css) md += `- **CSS:**\n\`\`\`css\n${a.css}\n\`\`\`\n`;
    for (const att of a.attachments || []) {
      const label = att.kind === 'capture' ? 'Screenshot' : 'Reference';
      if (att.export_path) md += `- **${label}:** ![${label}](${att.export_path})\n`;
      else if (att.unavailable) md += `- **${label}:** unavailable (${att.unavailable_reason || 'image bytes not included'})\n`;
    }
    md += '\n';
  });
  return md;
}
export default { renderAnnotationsMarkdown, sanitizeAnnotationForExport };
