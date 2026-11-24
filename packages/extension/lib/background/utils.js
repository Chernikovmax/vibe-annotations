// Background migration utilities

export async function migrateSyncFlags() {
  const result = await chrome.storage.local.get(['annotations', '_syncFlagsMigrated']);
  if (result._syncFlagsMigrated) return;
  const annotations = result.annotations || [];
  if (annotations.length) {
    let changed = false;
    for (const a of annotations) { if (!a._synced) { a._synced = true; changed = true; } }
    if (changed) await chrome.storage.local.set({ annotations });
  }
  await chrome.storage.local.set({ _syncFlagsMigrated: true });
}

