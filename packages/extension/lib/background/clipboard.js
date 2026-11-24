let creating;

export async function copyText(text) {
  if (typeof text !== 'string') throw new Error('Clipboard text must be a string');
  if (!await chrome.offscreen.hasDocument()) {
    if (!creating) {
      creating = chrome.offscreen.createDocument({
        url: 'clipboard.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy reviewed annotations independently of the host page Clipboard API',
      }).finally(() => { creating = null; });
    }
    await creating;
  }
  const response = await chrome.runtime.sendMessage({ target: 'offscreen-clipboard', text });
  if (!response?.success) throw new Error(response?.error || 'Could not copy to clipboard');
}
