// Roda quando o usuario chega em ler.amazon.com.br (apos login)
// Envia cookies para o KindleSync automaticamente

(async () => {
  // 1) Tenta config via query params do retorno da Amazon
  const params = new URLSearchParams(window.location.search);
  let serverUrl = (params.get('ks_server') || '').trim().replace(/\/$/, '');
  let token = (params.get('ks_token') || '').trim();

  // 2) Fallback: config salva no storage
  if (!serverUrl || !token) {
    try {
      const data = await chrome.storage.local.get(['serverUrl', 'token']);
      serverUrl = serverUrl || (data.serverUrl || '').trim().replace(/\/$/, '');
      token = token || (data.token || '').trim();
    } catch {}
  }

  // 3) Persiste config quando veio por query string
  if (serverUrl && token) {
    try {
      await chrome.storage.local.set({ serverUrl, token });
    } catch {}
  }

  // 4) Se ainda não tem config, não consegue enviar sessão
  if (!serverUrl || !token) {
    console.log('KindleSync: extensão sem configuração (server/token).');
    return;
  }

  // 5) Pede para o background capturar cookies completos (inclui HttpOnly)
  try {
    const data = await chrome.runtime.sendMessage({
      type: 'captureAndSend',
      serverUrl,
      token,
      currentCookie: document.cookie || '',
    });
    if (data && data.status === 'ok') {
      console.log('KindleSync: sessão enviada com sucesso!');

      if (window.opener) {
        window.opener.postMessage('amazon_login_done', '*');
      }

      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#3fb950;color:#000;text-align:center;padding:12px;font-size:16px;font-weight:bold;z-index:99999;';
      banner.textContent = 'KindleSync: Login capturado com sucesso! Pode fechar esta aba.';
      document.body.appendChild(banner);
      setTimeout(() => window.close(), 2000);
      return;
    }
  } catch (err) {
    console.warn('KindleSync: falha no captureAndSend, tentando fallback...', err);
  }

  // 6) Fallback legado (document.cookie)
  const cookies = document.cookie;
  if (!cookies) {
    console.log('KindleSync: nenhum cookie encontrado no fallback.');
    return;
  }

  try {
    const res = await fetch(`${serverUrl}/api/login/cookies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ cookies }),
    });
    const data = await res.json();
    if (data.status === 'ok') {
      if (window.opener) {
        window.opener.postMessage('amazon_login_done', '*');
      }
    } else {
      console.log('KindleSync: fallback retornou:', data);
    }
  } catch (err) {
    console.error('KindleSync extension fallback error:', err);
  }
})();
