const text = document.getElementById('text');
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.target !== 'offscreen-clipboard') return false;
  try {
    text.value = request.text;
    text.select();
    // Offscreen documents cannot receive focus for navigator.clipboard.writeText.
    if (!document.execCommand('copy')) throw new Error('Clipboard write was denied');
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  } finally {
    text.value = '';
  }
});
