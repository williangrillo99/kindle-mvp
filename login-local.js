#!/usr/bin/env node
// Script local: abre Chrome real, você faz login na Amazon, cookies são capturados automaticamente.
// Uso: node login-local.js

const { chromium } = require('playwright');

const SERVER_URL = process.env.SERVER_URL || 'http://68.183.110.111:3001';
const LOGIN_URL = 'https://www.amazon.com.br/ap/signin?openid.pape.max_auth_age=1209600&openid.return_to=https%3A%2F%2Fler.amazon.com.br%2Fkindle-library&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=amzn_kindle_mykindle_br&openid.mode=checkid_setup&language=pt_BR&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_kindle_mykindle_br&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0';

async function main() {
  // 1) Pede login no KindleSync pra pegar o token JWT
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.log('Uso: node login-local.js <email> <senha>');
    console.log('Exemplo: node login-local.js meuemail@gmail.com minhasenha');
    process.exit(1);
  }

  console.log(`Fazendo login no KindleSync (${SERVER_URL})...`);
  const authRes = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!authRes.ok) {
    const err = await authRes.json();
    console.error('Erro no login KindleSync:', err.error || 'Falha no login');
    process.exit(1);
  }

  const { token } = await authRes.json();
  console.log('Login KindleSync OK!');

  // 2) Abre Chrome REAL (não headless) na página de login da Amazon
  console.log('\nAbrindo Chrome... Faça login na Amazon normalmente.');
  console.log('Após o login, os cookies serão capturados automaticamente!\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 3) Fica monitorando a URL — quando sair do /ap/signin, login foi feito
  console.log('Aguardando login na Amazon...');

  while (true) {
    await page.waitForTimeout(2000);
    const url = page.url();

    // Ainda na página de login
    if (url.includes('/ap/signin') || url.includes('/ap/cvf') || url.includes('/ap/mfa') || url.includes('/ap/')) {
      continue;
    }

    // Saiu do login! Navega pra biblioteca pra confirmar
    try {
      if (!url.includes('/kindle-library')) {
        await page.goto('https://ler.amazon.com.br/kindle-library', {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        await page.waitForTimeout(2000);
      }

      const finalUrl = page.url();
      if (finalUrl.includes('/kindle-library') && !finalUrl.includes('signin')) {
        break; // Login confirmado!
      }
    } catch {
      continue;
    }
  }

  console.log('\nLogin na Amazon detectado! Capturando cookies...');

  // 4) Captura cookies e envia pro servidor
  const cookies = await context.cookies();
  const amazonCookies = cookies
    .filter(c => c.domain.includes('amazon'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  console.log(`${cookies.filter(c => c.domain.includes('amazon')).length} cookies da Amazon capturados.`);

  // Envia via API autenticada
  const sendRes = await fetch(`${SERVER_URL}/api/login/cookies`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ cookies: amazonCookies }),
  });

  const result = await sendRes.json();

  if (result.status === 'ok' || result.status === 'logged_in') {
    console.log('\nCookies enviados com sucesso para o servidor!');
    console.log('Agora você pode sincronizar seus highlights no KindleSync.');
  } else {
    console.log('\nResposta do servidor:', result);
  }

  await browser.close();
  console.log('Browser fechado. Pronto!');
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
