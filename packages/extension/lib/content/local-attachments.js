// JSON-only transport to the extension-origin Blob store; never the MAIN-world bridge.
async function request(action, fields = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...fields });
  if (!result?.success) throw new Error(result?.error || 'Local image operation failed');
  return result;
}

export default {
  capture: (draftId, captureMode, crop) => request('captureLocalAttachment', { draftId, captureMode, crop }),
  read: id => request('readLocalAttachment', { id }),
  remove: (id, draftId) => request('removeLocalAttachment', { id, draftId }),
  discard: draftId => request('discardLocalDraft', { draftId }),
  save: (annotation, localDraftId) => request('saveAnnotation', { annotation, localDraftId }),
  update: (id, updates, localDraftId) => request('updateAnnotation', { id, updates, localDraftId }),
};
