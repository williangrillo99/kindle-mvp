// Roda quando o usuario chega em ler.amazon.com.br (apos login)
// Envia cookies para o KindleSync automaticamente

(async () => {
  // Pega config do chrome.storage.local (setada na pagina de opcoes da extensao)
  let serverUrl = '';
  let token = '';

  try {
    const data = await chrome.storage.local.get(['serverUrl', 'token']);
    serverUrl = data.serverUrl || '';
    token = data.token || '';
  } catch {}

  if (!serverUrl || !token) {
    console.log('KindleSync: extensão não configurada. Abra as opções da extensão.');
    return;
  }

  // Captura cookies
  const cookies = document.cookie;
  if (!cookies) {
    console.log('KindleSync: nenhum cookie encontrado.');
    return;
  }

  console.log('KindleSync: enviando cookies para o servidor...');

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
      console.log('KindleSync: cookies enviados com sucesso!');

      // Avisa a janela do KindleSync (se foi aberta por ela)
      if (window.opener) {
        window.opener.postMessage('amazon_login_done', '*');
      }

      // Mostra feedback visual
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#3fb950;color:#000;text-align:center;padding:12px;font-size:16px;font-weight:bold;z-index:99999;';
      banner.textContent = 'KindleSync: Login capturado com sucesso! Pode fechar esta aba.';
      document.body.appendChild(banner);
      setTimeout(() => window.close(), 3000);
    } else {
      console.log('KindleSync: resposta do servidor:', data);
    }
  } catch (err) {
    console.error('KindleSync extension error:', err);
  }
})();
