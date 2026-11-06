import LocalAttachments from './local-attachments.js';
import { renderAnnotationsMarkdown, sanitizeAnnotationForExport } from './export-markdown.js';

const textEncoder = new TextEncoder();
function u16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
function u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
function join(parts) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  if (files.length > 65535) throw new Error('Too many files for a ZIP export; select fewer annotations');
  const locals = [], central = []; let offset = 0;
  for (const file of files) {
    const name = textEncoder.encode(file.name), data = file.bytes, crc = crc32(data);
    const local = join([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]);
    locals.push(local, data);
    central.push(join([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length + data.length;
  }
  const end = join([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.reduce((n, p) => n + p.length, 0)), u32(offset), u16(0)]);
  return new Blob([...locals, ...central, end], { type: 'application/zip' });
}
function dataUrlBytes(dataUrl) {
  const comma = String(dataUrl || '').indexOf(',');
  if (comma < 0) throw new Error('Local attachment has no readable bytes');
  const raw = atob(dataUrl.slice(comma + 1)); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return bytes;
}

export async function buildLocalExport(annotations, selectedIds = null, excluded = new Set()) {
  const selected = annotations.filter(a => !selectedIds || selectedIds.has(a.id));
  const attachmentFiles = new Map(), relationships = [];
  const exported = [];
  for (const annotation of selected) {
    const copy = sanitizeAnnotationForExport(annotation, excluded);
    const attachments = [];
    for (const att of annotation.attachments || []) {
      if (excluded.has(`${annotation.id}:image:${att.id}`)) continue;
      if (att.local_only) {
        let result;
        try { result = await LocalAttachments.read(att.id); } catch (error) { throw new Error(`Attachment ${att.id} is unavailable: ${error.message}`); }
        const metadata = result.attachment;
        if (metadata?.mime !== 'image/webp' || !/^[a-zA-Z0-9_-]+$/.test(att.id)) throw new Error(`Attachment ${att.id} is not a supported local WebP`);
        const path = `attachments/${att.id}.webp`;
        if (!attachmentFiles.has(path)) {
          const bytes = dataUrlBytes(result.dataUrl);
          if (bytes.length !== metadata.byte_length) throw new Error(`Attachment ${att.id} has incomplete local bytes`);
          let bitmap;
          try {
            bitmap = await createImageBitmap(new Blob([bytes], { type: metadata.mime }));
            if (bitmap.width !== metadata.width || bitmap.height !== metadata.height) throw new Error('Image dimensions do not match its record');
          } catch (error) { throw new Error(`Attachment ${att.id} cannot be decoded: ${error.message}`); }
          finally { bitmap?.close(); }
          attachmentFiles.set(path, { name: path, bytes });
        }
        const { id, kind, capture_mode, mime, width, height, byte_length, created_at } = metadata;
        attachments.push({ id, local_only: true, kind, capture_mode, mime, width, height, byte_length, created_at, export_path: path });
        relationships.push({ annotation_id: annotation.id, attachment_id: att.id, path });
      } else {
        attachments.push({ id: att.id, kind: att.kind, unavailable: true, unavailable_reason: 'Legacy server attachment is not included in local export' });
      }
    }
    exported.push({ ...copy, attachments });
  }
  const host = window.location.host;
  const json = { vibe_annotations_export: true, version: '2.0', exported_at: new Date().toISOString(), source: { origin: window.location.origin, hostname: window.location.hostname }, annotations: exported, attachments: relationships };
  const markdown = renderAnnotationsMarkdown(exported, host);
  const files = [
    { name: 'annotations.json', bytes: textEncoder.encode(JSON.stringify(json, null, 2)) },
    { name: 'annotations.md', bytes: textEncoder.encode(markdown) },
    ...attachmentFiles.values()
  ];
  return { blob: zip(files), json, markdown };
}

function fieldRows(value, annotationId, path = '') {
  return Object.entries(value).map(([key, item]) => {
    const pointer = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    const label = `<label class="vibe-export-field"><input type="checkbox" data-field="${escapeAttr(annotationId)}:${escapeAttr(pointer)}" data-annotation="${escapeAttr(annotationId)}" data-path="${escapeAttr(pointer)}" checked ${pointer === '/id' ? 'disabled' : ''}><span>${escapeHTML(key)}${item !== null && typeof item === 'object' ? '' : `: ${escapeHTML(item)}`}</span></label>`;
    return item !== null && typeof item === 'object'
      ? `<details open><summary>${label}</summary>${fieldRows(item, annotationId, pointer)}</details>` : label;
  }).join('');
}
export function openExportReview(annotations, mode = 'zip') {
  return new Promise(resolve => {
    const root = document.createElement('div'); root.className = 'vibe-export-review';
    const previews = [];
    const rows = annotations.map(a => {
      const fields = fieldRows(sanitizeAnnotationForExport(a), a.id);
      const images = (a.attachments || []).map(att => {
        const index = previews.length;
        if (att.local_only) previews.push(att);
        return `<label class="vibe-export-field"><input type="checkbox" data-image="${escapeAttr(a.id)}:${escapeAttr(att.id)}" data-annotation="${escapeAttr(a.id)}" data-attachment="${escapeAttr(att.id)}" checked><span>${att.local_only ? 'Local image' : 'Legacy server image (unavailable)'} ${escapeHTML(att.id)}</span></label>${att.local_only ? `<img class="vibe-export-preview" data-preview="${index}" alt="Loading local screenshot"><span class="vibe-export-preview-status" data-preview-status="${index}"></span>` : ''}`;
      }).join('');
      return `<section class="vibe-export-item"><label class="vibe-export-row"><input type="checkbox" data-id="${escapeAttr(a.id)}" checked><strong>${escapeHTML(a.comment || a.id)}</strong></label>${fields}${images}</section>`;
    }).join('');
    root.innerHTML = `<div class="vibe-export-card" role="dialog" aria-label="Review export"><h2>Review export</h2><p>Every retained field is shown below, including existing DOM and Angular context. Uncheck sensitive fields, annotations, or images. URL query and fragment are removed from the copy. Exclusions never change originals.</p><div class="vibe-export-list">${rows}</div><div class="vibe-export-error" role="alert"></div><div class="vibe-export-actions"><button class="vibe-btn vibe-btn-secondary" type="button" data-action="cancel">Cancel</button><button class="vibe-btn vibe-btn-primary" type="button" data-action="continue" disabled>${mode === 'copy' ? 'Copy text (images require ZIP)' : 'Export ZIP'}</button></div></div>`;
    const host = document.getElementById('vibe-annotations-root');
    (host?.shadowRoot || document.body).appendChild(root);
    const button = root.querySelector('[data-action="continue"]');
    Promise.all(previews.map(async (att, index) => {
      const img = root.querySelector(`[data-preview="${index}"]`);
      try {
        const response = await LocalAttachments.read(att.id);
        img.src = response.dataUrl;
        await img.decode();
        img.alt = `Local screenshot ${att.id}`;
      } catch (error) {
        img.remove();
        root.querySelector(`[data-preview-status="${index}"]`).textContent = `Image unavailable: ${error.message}. Exclude it or restore its local data.`;
      }
    })).then(() => { button.disabled = false; });
    root.querySelector('[data-action="cancel"]').onclick = () => { root.remove(); resolve(null); };
    button.onclick = async () => {
      button.disabled = true;
      const selected = new Set([...root.querySelectorAll('[data-id]:checked')].map(x => x.dataset.id));
      const excluded = new Set();
      for (const field of root.querySelectorAll('[data-field]:not(:checked)')) excluded.add(`${field.dataset.annotation}:field:${field.dataset.path}`);
      for (const image of root.querySelectorAll('[data-image]:not(:checked)')) excluded.add(`${image.dataset.annotation}:image:${image.dataset.attachment}`);
      try {
        if (!selected.size) throw new Error('Select at least one annotation');
        const result = await buildLocalExport(annotations, selected, excluded);
        if (mode === 'copy') {
          const textOnly = result.json.annotations.map(a => ({ ...a, attachments: a.attachments.map(att => ({ id: att.id, kind: att.kind, unavailable: true, unavailable_reason: att.unavailable_reason || 'Copied text does not transfer image bytes; use ZIP export' })) }));
          await navigator.clipboard.writeText(renderAnnotationsMarkdown(textOnly, window.location.host));
        }
        root.remove(); resolve({ ...result, selected, excluded });
      } catch (error) {
        root.querySelector('.vibe-export-error').textContent = error.message;
        button.disabled = false;
      }
    };
  });
}
function escapeHTML(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(v) { return escapeHTML(v).replace(/`/g, '&#96;'); }
export default { buildLocalExport, openExportReview };
