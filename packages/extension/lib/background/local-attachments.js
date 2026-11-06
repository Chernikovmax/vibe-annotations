const DB_NAME = 'vibe-annotations-local-attachments';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('draft_id', 'draft_id', { unique: false });
          store.createIndex('annotation_id', 'annotation_id', { unique: false });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('Unable to open local attachment store'));
      request.onblocked = () => reject(new Error('Local attachment store upgrade is blocked'));
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function metadata(record) {
  const { blob, published_at, ...item } = record;
  return item;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('Local attachment transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('Local attachment transaction failed'));
  });
}

async function cleanupExpiredInTransaction(store, now) {
  const records = await requestResult(store.getAll());
  for (const item of records) {
    if (!item.annotation_id && now - Date.parse(item.created_at) > DRAFT_MAX_AGE_MS) store.delete(item.id);
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local attachment request failed'));
  });
}

export async function cleanupExpiredDrafts(now = Date.now()) {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  await cleanupExpiredInTransaction(tx.objectStore(STORE_NAME), now);
  await done;
}

export async function createLocalAttachment({ draft_id, capture_mode, mime, width, height, blob }) {
  if (typeof draft_id !== 'string' || !draft_id) throw new Error('A draft id is required');
  if (!(blob instanceof Blob) || !blob.size) throw new Error('Captured image is empty');
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('Image exceeds the 15 MiB local attachment limit');
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const record = {
    id, local_only: true, kind: 'capture', capture_mode, draft_id,
    mime: mime || blob.type || 'image/webp', width, height,
    byte_length: blob.size, created_at, blob,
  };
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  try {
    await cleanupExpiredInTransaction(store, Date.now());
    const records = await requestResult(store.getAll());
    const total = records.reduce((sum, item) => sum + item.byte_length, 0);
    if (total + record.byte_length > MAX_TOTAL_BYTES) throw new Error('Local attachments exceed the 100 MiB total limit');
    store.add(record);
    await done;
  } catch (error) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw error;
  }
  return metadata(record);
}

export async function readLocalAttachment(id) {
  await cleanupExpiredDrafts();
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const done = transactionDone(tx);
  const item = await requestResult(tx.objectStore(STORE_NAME).get(id));
  await done;
  if (!item) throw new Error('Local attachment not found');
  if (item.byte_length > MAX_ATTACHMENT_BYTES) throw new Error('Image exceeds the 15 MiB preview limit');
  const dataUrl = `data:${item.mime};base64,${await blobToBase64(item.blob)}`;
  return { attachment: metadata(item), dataUrl };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function listLocalAttachments({ draftId, annotationId } = {}) {
  await cleanupExpiredDrafts();
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const done = transactionDone(tx);
  const all = await requestResult(tx.objectStore(STORE_NAME).getAll());
  await done;
  return all.filter(item => (!draftId || item.draft_id === draftId) && (!annotationId || item.annotation_id === annotationId)).map(metadata);
}

export async function bindLocalAttachments(draftId, annotationId, ids = []) {
  if (!draftId || !annotationId || !Array.isArray(ids)) throw new Error('Draft, annotation, and attachment ids are required');
  const uniqueIds = [...new Set(ids)];
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  try {
    await cleanupExpiredInTransaction(store, Date.now());
    const items = await Promise.all(uniqueIds.map(id => requestResult(store.get(id))));
    for (const item of items) {
      if (!item || item.draft_id !== draftId || (item.annotation_id && item.annotation_id !== annotationId)) {
        throw new Error('Local attachment does not belong to this draft or annotation');
      }
    }
    for (const item of items) {
      item.annotation_id = annotationId;
      store.put(item);
    }
    await done;
    return items.map(metadata);
  } catch (error) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw error;
  }
}
export async function confirmLocalAttachmentsPublished(annotationId, ids) {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const now = new Date().toISOString();
  for (const id of new Set(ids)) {
    const item = await requestResult(store.get(id));
    if (item?.annotation_id === annotationId) {
      item.published_at ||= now;
      store.put(item);
    }
  }
  await done;
}

export async function reconcileLocalAttachmentReferences(referencedIds) {
  const referenced = new Set(referencedIds);
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const items = await requestResult(store.getAll());
  for (const item of items) {
    if (!item.annotation_id) continue;
    if (referenced.has(item.id)) {
      item.published_at ||= new Date().toISOString();
      store.put(item);
    } else if (item.published_at) {
      store.delete(item.id);
    } else {
      delete item.annotation_id;
      store.put(item);
    }
  }
  await done;
}

export async function removeLocalAttachment(id, draftId) {
  await cleanupExpiredDrafts();
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const item = await requestResult(store.get(id));
  if (item && item.draft_id === draftId && !item.annotation_id) store.delete(id);
  await done;
  return Boolean(item && item.draft_id === draftId && !item.annotation_id);
}

export async function discardLocalDraft(draftId) {
  if (!draftId) throw new Error('A draft id is required');
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const items = await requestResult(store.index('draft_id').getAll(draftId));
  for (const item of items) if (!item.annotation_id) store.delete(item.id);
  await done;
  return { removed: items.filter(item => !item.annotation_id).length };
}

export async function removeBoundLocalAttachments(annotationId, keepIds = []) {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const items = await requestResult(store.index('annotation_id').getAll(annotationId));
  const keep = new Set(keepIds);
  for (const item of items) if (!keep.has(item.id)) store.delete(item.id);
  await done;
  return items.filter(item => !keep.has(item.id)).length;
}

export async function unbindLocalAttachments(annotationId, ids) {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  for (const id of new Set(ids)) {
    const item = await requestResult(store.get(id));
    if (item?.annotation_id === annotationId) {
      delete item.annotation_id;
      store.put(item);
    }
  }
  await done;
}
export async function removeBoundLocalAttachmentIds(annotationId, ids) {
  const wanted = new Set(ids);
  if (!wanted.size) return 0;
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  let removed = 0;
  for (const id of wanted) {
    const item = await requestResult(store.get(id));
    if (item?.annotation_id === annotationId) {
      store.delete(id);
      removed++;
    }
  }
  await done;
  return removed;
}

export async function clearLocalAttachments() {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_NAME);
  const items = await requestResult(store.getAll());
  store.clear();
  await done;
  return { removed: items.length, attachmentIds: items.map(item => item.id), annotationIds: [...new Set(items.map(item => item.annotation_id).filter(Boolean))] };
}

