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

// Recebe pedidos do content script para capturar e enviar cookies completos
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'captureAndSend') return;

  (async () => {
    const serverUrl = (message.serverUrl || '').trim().replace(/\/$/, '');
    const token = (message.token || '').trim();
    const currentCookie = message.currentCookie || '';
    if (!serverUrl || !token) {
      sendResponse({ status: 'error', error: 'missing_config' });
      return;
    }

    try {
      const allCookies = await chrome.cookies.getAll({ domain: '.amazon.com.br' });
      const cookieStr = (allCookies && allCookies.length > 0)
        ? allCookies.map(c => `${c.name}=${c.value}`).join('; ')
        : currentCookie;

      if (!cookieStr) {
        sendResponse({ status: 'error', error: 'no_cookies' });
        return;
      }

      const res = await fetch(`${serverUrl}/api/login/cookies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ cookies: cookieStr }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        sendResponse({ status: 'error', error: data.error || `http_${res.status}` });
        return;
      }

      sendResponse({ status: 'ok', data });
    } catch (err) {
      sendResponse({ status: 'error', error: String(err && err.message ? err.message : err) });
    }
  })();

  return true; // async response
});
