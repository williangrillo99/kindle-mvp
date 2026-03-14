// Recebe mensagens externas do KindleSync para configurar a extensao automaticamente
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message.type === 'configure') {
    chrome.storage.local.set({
      serverUrl: message.serverUrl,
      token: message.token,
    }, () => {
      sendResponse({ status: 'ok' });
    });
    return true; // keeps sendResponse alive for async
  }
});
