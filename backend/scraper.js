const { chromium } = require('playwright');

const CLOUD_READER_URL = 'https://ler.amazon.com.br';
const LOGIN_URL = 'https://www.amazon.com.br/ap/signin?openid.pape.max_auth_age=1209600&openid.return_to=https%3A%2F%2Fler.amazon.com.br%2Fkindle-library&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=amzn_kindle_mykindle_br&openid.mode=checkid_setup&language=pt_BR&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_kindle_mykindle_br&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0';

// HEADLESS=false força modo visível sempre.
// Se não definido, login manual abre visível e automático mantém headless.
const FORCE_HEADED = process.env.HEADLESS === 'false';

// Instâncias por usuário: Map<userId, { browser, context, page, syncProgress, adpToken }>
const userSessions = new Map();

function getSession(userId) {
  return userSessions.get(userId) || null;
}

function getSyncProgress(userId) {
  const s = getSession(userId);
  return s ? s.syncProgress : { current: 0, total: 0, bookTitle: '' };
}

async function openLogin(userId, savedSessionData, amazonEmail, amazonPassword) {
  let s = getSession(userId);
  if (s && s.browser) return { status: 'already_open' };

  const isManualLogin = !amazonEmail || !amazonPassword;
  const headless = FORCE_HEADED ? false : !isManualLogin;

  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const contextOptions = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  };

  // Restaura sessão salva do DB se existir
  if (savedSessionData) {
    try {
      contextOptions.storageState = JSON.parse(savedSessionData);
      console.log(`[${userId}] Restaurando sessão salva...`);
    } catch {
      console.log(`[${userId}] Sessão salva inválida, ignorando...`);
    }
  }

  const context = await browser.newContext(contextOptions);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  s = { browser, context, page, syncProgress: { current: 0, total: 0, bookTitle: '' }, adpToken: '' };
  userSessions.set(userId, s);

  browser.on('disconnected', () => {
    console.log(`[${userId}] Browser desconectado`);
    userSessions.delete(userId);
  });

  // Navega para login da Amazon
  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Se tem sessão salva, verifica se já está logado
  if (savedSessionData) {
    try {
      await page.goto(`${CLOUD_READER_URL}/kindle-library`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const url = page.url();
      if (url.includes('/kindle-library') && !url.includes('signin') && !url.includes('/ap/')) {
        console.log(`[${userId}] Sessão restaurada com sucesso`);
        const sessionState = await context.storageState();
        return { status: 'logged_in', sessionState, adpToken: s.adpToken };
      }
      // Sessão expirou, faz login com credenciais
      console.log(`[${userId}] Sessão expirada, fazendo login...`);
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      console.log(`[${userId}] Erro ao restaurar sessão, tentando login...`);
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
  }

  // Modo interativo: abre browser real e espera login manual
  if (!amazonEmail || !amazonPassword) {
    console.log(`[${userId}] Modo interativo: faça login na janela do browser...`);
    return { status: 'waiting_manual_login' };
  }

  // Modo automático: login com email/senha
  if (!amazonEmail || !amazonPassword) {
    throw new Error('Credenciais Amazon necessárias para login.');
  }

  try {
    // Preenche email
    await page.waitForSelector('#ap_email', { timeout: 10000 });
    await page.fill('#ap_email', amazonEmail);

    // Alguns fluxos tem botão "Continuar" antes da senha
    const continueBtn = await page.$('#continue');
    if (continueBtn) {
      await continueBtn.click();
      await page.waitForTimeout(2000);
    }

    // Preenche senha
    await page.waitForSelector('#ap_password', { timeout: 10000 });
    await page.fill('#ap_password', amazonPassword);

    // Clica em "Fazer login"
    await page.click('#signInSubmit');
    await page.waitForTimeout(3000);

    // Verifica se precisa de captcha ou 2FA
    const url = page.url();
    if (url.includes('/ap/cvf') || url.includes('/ap/mfa')) {
      // Precisa de código de verificação (2FA/OTP)
      return { status: 'needs_otp' };
    }

    if (url.includes('/errors/validateCaptcha') || await page.$('#auth-captcha-image')) {
      throw new Error('Amazon pediu captcha. Tente novamente em alguns minutos.');
    }

    // Verifica se login foi bem sucedido
    if (url.includes('/ap/signin') || url.includes('/ap/')) {
      const errorEl = await page.$('#auth-error-message-box, .a-alert-content');
      if (errorEl) {
        const errorText = await errorEl.textContent();
        throw new Error(`Login falhou: ${errorText.trim()}`);
      }
      throw new Error('Login falhou. Verifique email e senha.');
    }

    // Navega para a biblioteca
    await page.goto(`${CLOUD_READER_URL}/kindle-library`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    if (finalUrl.includes('/kindle-library') && !finalUrl.includes('signin')) {
      console.log(`[${userId}] Login Amazon OK`);
      const sessionState = await context.storageState();
      return { status: 'logged_in', sessionState, adpToken: s.adpToken };
    }

    throw new Error('Não foi possível acessar a biblioteca Kindle após login.');
  } catch (err) {
    if (err.message.includes('needs_otp') || err.message === 'needs_otp') {
      return { status: 'needs_otp' };
    }
    await closeBrowser(userId);
    throw err;
  }
}

async function submitOTP(userId, otpCode) {
  const s = getSession(userId);
  if (!s || !s.page) throw new Error('Browser não iniciado');

  const { page, context } = s;

  try {
    // Preenche o código OTP
    const otpInput = await page.$('#auth-mfa-otpcode, #cvf-input-code, input[name="otpCode"], input[name="code"]');
    if (!otpInput) throw new Error('Campo de código não encontrado.');

    await otpInput.fill(otpCode);

    // Clica no botão de submit
    const submitBtn = await page.$('#auth-signin-button, #cvf-submit-code-button, button[type="submit"]');
    if (submitBtn) await submitBtn.click();

    await page.waitForTimeout(3000);

    const url = page.url();
    if (url.includes('/ap/cvf') || url.includes('/ap/mfa')) {
      throw new Error('Código inválido. Tente novamente.');
    }

    // Navega para a biblioteca
    await page.goto(`${CLOUD_READER_URL}/kindle-library`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    if (finalUrl.includes('/kindle-library') && !finalUrl.includes('signin')) {
      console.log(`[${userId}] Login com OTP OK`);
      const sessionState = await context.storageState();
      return { status: 'logged_in', sessionState, adpToken: s.adpToken };
    }

    throw new Error('Não foi possível acessar a biblioteca após verificação.');
  } catch (err) {
    if (err.message.includes('Código inválido')) throw err;
    await closeBrowser(userId);
    throw err;
  }
}

async function scrapeAll(userId) {
  const s = getSession(userId);
  if (!s || !s.page) throw new Error('Browser não iniciado');

  const { page } = s;

  // Captura dados brutos de annotations e x-adp-session-token
  const annotationsCache = {};
  const revisionCache = {};
  page.on('request', req => {
    const adp = req.headers()['x-adp-session-token'];
    if (adp) s.adpToken = adp;
  });
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('getAnnotations')) {
      try {
        const body = await res.json();
        const asinMatch = url.match(/asin=([^&]+)/);
        const revisionMatch = url.match(/revision=([^&]+)/);
        if (asinMatch && body.annotations) {
          annotationsCache[asinMatch[1]] = body.annotations;
          if (revisionMatch) {
            revisionCache[asinMatch[1]] = revisionMatch[1];
          }
          console.log(`[NET] Cached ${body.annotations.length} annotations for ${asinMatch[1]}`);
        }
      } catch {}
    }
  });

  // 1) Navega para a biblioteca do Cloud Reader
  console.log('Navegando para Cloud Reader Library...');
  await page.goto(`${CLOUD_READER_URL}/kindle-library`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  try {
    await page.waitForSelector('#itemViewResponse', { timeout: 10000 });
  } catch {
    await page.waitForTimeout(2000);
  }

  // Extrai lista de livros do JSON embutido
  let bookList = await page.evaluate(() => {
    const jsonEl = document.querySelector('#itemViewResponse');
    if (jsonEl) {
      try {
        const data = JSON.parse(jsonEl.textContent);
        if (data.itemsList) {
          return data.itemsList.map(item => ({
            asin: item.asin || '',
            title: item.title || '',
            author: item.authors ? item.authors.join(', ') : '',
            cover: item.mangaCover || item.productUrl || '',
            highlights: [],
          }));
        }
      } catch {}
    }
    return [];
  });

  // Fallback: extrai do DOM
  if (bookList.length === 0) {
    bookList = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('li[id^="library-item-option-"]').forEach(li => {
        const asin = li.id.replace('library-item-option-', '');
        const titleEl = document.querySelector(`#title-${asin} p`);
        const authorEl = document.querySelector(`#author-${asin} p`);
        const imgEl = document.querySelector(`#cover-${asin}`);
        results.push({
          asin,
          title: titleEl ? titleEl.textContent.trim() : '',
          author: authorEl ? authorEl.textContent.trim() : '',
          cover: imgEl ? imgEl.src : '',
          highlights: [],
        });
      });
      return results;
    });
  }

  console.log(`Livros encontrados: ${bookList.length}`);
  if (bookList.length === 0) return [];

  bookList.forEach((b, idx) => console.log(`  [${idx}] ASIN=${b.asin} - ${b.title}`));
  s.syncProgress = { current: 0, total: bookList.length, bookTitle: '' };

  // 2) Para cada livro: abre no Cloud Reader e extrai dados
  for (let i = 0; i < bookList.length; i++) {
    const asin = bookList[i].asin;
    if (!asin) continue;

    s.syncProgress = { current: i + 1, total: bookList.length, bookTitle: bookList[i].title };
    console.log(`\n[${i + 1}/${bookList.length}] Abrindo: ${bookList[i].title}`);

    try {
      // Passo 1: Abre no Cloud Reader pra pegar progresso + API annotations
      await page.goto(`${CLOUD_READER_URL}/?asin=${asin}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      try {
        await page.waitForSelector('.footer-label, [data-testid="top_menu_notebook"]', { timeout: 8000 });
      } catch {}

      // Fecha alert "Most Recent Page Read" se aparecer
      try {
        const alertBtn = await page.$('ion-alert button');
        if (alertBtn) await alertBtn.click();
        await page.waitForTimeout(300);
      } catch {}

      // Clica no centro para mostrar a toolbar
      await page.mouse.click(400, 300);
      await page.waitForTimeout(500);

      // Extrai progresso de leitura
      const progress = await page.evaluate(() => {
        const footerEl = document.querySelector('.footer-label.position .text-div, ion-title.footer-label.position');
        if (!footerEl) return null;
        const text = footerEl.textContent.trim();
        const match = text.match(/Page\s+(\d+)\s+of\s+(\d+)\s*●?\s*(\d+)%?/i);
        if (match) {
          return { currentPage: parseInt(match[1]), totalPages: parseInt(match[2]), percent: parseInt(match[3]) };
        }
        return null;
      });
      if (progress) {
        bookList[i].progress = progress;
        console.log(`  Progresso: Pág. ${progress.currentPage}/${progress.totalPages} (${progress.percent}%)`);
      }

      // Passo 2: Navega para o Notebook pra pegar texto completo dos highlights
      await page.goto(`${CLOUD_READER_URL}/notebook?asin=${asin}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      try {
        await page.waitForSelector('#annotation-scroller, .kp-notebook-annotations-container, .a-row.kp-notebook-row', { timeout: 10000 });
      } catch {
        await page.waitForTimeout(3000);
      }

      // Extrai highlights da página do Notebook
      const highlights = await page.evaluate(() => {
        const results = [];

        // Tenta seletores do Kindle Notebook
        const annotations = document.querySelectorAll('#highlight, .kp-notebook-highlight, [id^="highlight-"]');
        if (annotations.length > 0) {
          annotations.forEach(el => {
            const text = el.textContent.trim();
            if (!text) return;
            const parent = el.closest('.a-row, .kp-notebook-row, [id^="annotation-"]');
            let note = '';
            let page = '';
            let color = 'yellow';
            let chapter = '';
            if (parent) {
              const noteEl = parent.querySelector('#note, .kp-notebook-note, [id^="note-"]');
              if (noteEl) note = noteEl.textContent.trim();
              const metaEl = parent.querySelector('#annotationHighlightHeader, .kp-notebook-metadata, .a-color-secondary');
              if (metaEl) {
                const metaText = metaEl.textContent.trim();
                const pageMatch = metaText.match(/Page\s+(\d+)/i) || metaText.match(/P[aá]g[a-z]*\.?\s+(\d+)/i) || metaText.match(/Location\s+(\d+)/i);
                if (pageMatch) page = pageMatch[1];
                const colorMatch = metaText.match(/(Yellow|Blue|Pink|Orange)/i);
                if (colorMatch) color = colorMatch[1].toLowerCase();
              }
            }
            results.push({ text, note, color, type: 'highlight', page, chapter, location: '', locationNum: '' });
          });
          return results;
        }

        // Fallback: seletores do Cloud Reader notebook panel
        const chapters = document.querySelectorAll('.notebook-chapter');
        chapters.forEach(ch => {
          const chapterTitle = ch.querySelector('.notebook-chapter--title')?.textContent.trim() || '';
          ch.querySelectorAll('.notebook-editable-item-wrapper').forEach(wrapper => {
            const titleEl = wrapper.querySelector('p.grouped-annotation_title');
            const textEl = wrapper.querySelector('p.notebook-editable-item-black');
            const colorEl = wrapper.querySelector('[class*="notebook-editable-item__highlight-color--"]');
            const noteEl = wrapper.querySelector('.notebook-editable-item--note, [class*="note-text"], p.notebook-editable-item-gray, .notebook-editable-item-note');
            if (!textEl) return;
            const headerText = titleEl ? titleEl.textContent.trim() : '';
            const text = textEl.textContent.trim();
            if (!text) return;
            let type = 'highlight';
            if (/^Note/i.test(headerText) || /^Nota/i.test(headerText)) return;
            else if (/^Bookmark/i.test(headerText) || /^Marcador/i.test(headerText)) type = 'bookmark';
            let page = '';
            const pageMatch = headerText.match(/Page\s+(\d+)/i) || headerText.match(/P[aá]g[a-z]*\.?\s+(\d+)/i);
            if (pageMatch) page = pageMatch[1];
            let color = 'yellow';
            if (colorEl) {
              const cls = colorEl.className || '';
              const colorMatch = cls.match(/highlight-color--(\w+)/);
              if (colorMatch) color = colorMatch[1];
            }
            let note = '';
            if (noteEl) {
              note = noteEl.textContent.trim();
            } else {
              const allPs = wrapper.querySelectorAll('p');
              for (const p of allPs) {
                if (p === textEl || p === titleEl) continue;
                if (p.classList.contains('grouped-annotation_title')) continue;
                const pText = p.textContent.trim();
                if (pText && pText !== text) { note = pText; break; }
              }
            }
            results.push({ text, note, color, type, page, chapter: chapterTitle, location: headerText, locationNum: '' });
          });
        });
        return results;
      });

      // Enriquece highlights com dados da API (position, guid, dsn)
      const apiAnnotations = annotationsCache[asin] || [];
      const apiHighlights = apiAnnotations.filter(a => a.type === 'kindle.highlight');
      const apiNotes = apiAnnotations.filter(a => a.type === 'kindle.note');

      bookList[i]._revision = revisionCache[asin] || '';

      bookList[i].highlights = highlights.map((h) => {
        const apiMatch = apiHighlights.find(a => {
          if (!a.context || !h.text) return false;
          const apiSnippet = a.context.substring(0, 60);
          return h.text.includes(apiSnippet) || apiSnippet.includes(h.text.substring(0, 60));
        });
        let text = h.text;
        if (apiMatch && apiMatch.context && apiMatch.context.length > text.length) {
          text = apiMatch.context;
        }
        let note = h.note;
        if (apiMatch && !note) {
          const linkedNote = apiNotes.find(n => n.start === apiMatch.end || n.position === apiMatch.end);
          if (linkedNote) note = linkedNote.note;
        }
        return {
          text,
          note,
          location: h.location,
          color: h.color,
          type: h.type,
          page: h.page,
          locationNum: '',
          date: '',
          chapter: h.chapter,
          _position: apiMatch ? apiMatch.position : null,
          _start: apiMatch ? apiMatch.start : null,
          _end: apiMatch ? apiMatch.end : null,
          _guid: apiMatch ? apiMatch.guid : null,
          _dsn: apiMatch ? apiMatch.dsn : null,
          _positionType: apiMatch ? apiMatch.positionType : 'YJBinary',
        };
      });

      // Deduplica highlights pelo texto
      const seen = new Set();
      bookList[i].highlights = bookList[i].highlights.filter(h => {
        const key = h.text.substring(0, 80);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const notesCount = bookList[i].highlights.filter(h => h.note).length;
      console.log(`  ${bookList[i].highlights.length} destaques encontrados (${notesCount} com notas)`);
    } catch (err) {
      console.log(`  Erro: ${err.message}`);
      bookList[i].highlights = [];
    }
  }

  // Salva sessão e retorna junto com os livros
  let sessionState = null;
  try {
    sessionState = await s.context.storageState();
  } catch {}

  // Anexa metadados de sessão ao resultado
  bookList._sessionState = sessionState;
  bookList._adpToken = s.adpToken;

  return bookList;
}

// Edita nota via HTTP usando cookies da sessão do DB
async function editNote(asin, highlightIndex, newNote, highlightData, bookData, amazonSession) {
  console.log(`[editNote] Editando nota via HTTP - ASIN=${asin}, index=${highlightIndex}`);

  if (!highlightData || !highlightData._end || !highlightData._guid) {
    throw new Error('Dados da annotation não encontrados. Faça sync novamente.');
  }

  if (!amazonSession) {
    throw new Error('Sessão Amazon não encontrada. Faça sync novamente.');
  }

  const sessionData = JSON.parse(amazonSession.session_data);
  const cookies = sessionData.cookies || [];

  const cookieStr = cookies
    .filter(c => c.domain.includes('amazon'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) {
    throw new Error('Cookies da Amazon não encontrados na sessão.');
  }

  const adpToken = amazonSession.adp_token || '';
  if (!adpToken) {
    throw new Error('ADP session token não encontrado. Faça sync novamente.');
  }

  const revision = (bookData && bookData._revision) || '';

  const headers = {
    'Cookie': cookieStr,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': CLOUD_READER_URL,
    'Referer': `${CLOUD_READER_URL}/?asin=${asin}`,
    'x-adp-session-token': adpToken,
  };

  // 1) Busca CSRF token
  const csrfRes = await fetch(`${CLOUD_READER_URL}/reader/api/csrf/getToken`, { headers });
  const csrfToken = await csrfRes.text();

  // 2) Monta body no formato Amazon Coral
  const noteAnnotation = {
    asin: asin,
    position: highlightData._end,
    start: highlightData._end,
    end: highlightData._end,
    context: null,
    highlightColor: null,
    type: 'kindle.note',
    modifiedTimestamp: Date.now(),
    note: newNote,
    action: 'update',
    positionType: 'YJBinary',
    guid: highlightData._guid,
  };

  const body = {
    Operation: 'updateAnnotations',
    Input: {
      asin: asin,
      revision: revision,
      annotations: [noteAnnotation],
      localTimeOffset: -180,
      clientVersion: '20000100',
    },
  };

  const updateUrl = `${CLOUD_READER_URL}/service/mobile/reader/updateAnnotations`;

  const updateRes = await fetch(updateUrl, {
    method: 'POST',
    headers: { ...headers, 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  });

  const responseText = await updateRes.text();
  console.log(`[editNote] Response ${updateRes.status}: ${responseText.substring(0, 500)}`);

  if (!updateRes.ok) {
    throw new Error(`API Amazon retornou ${updateRes.status}: ${responseText.substring(0, 200)}`);
  }

  try {
    const resJson = JSON.parse(responseText);
    if (resJson.Output && resJson.Output.__type && resJson.Output.__type.includes('Exception')) {
      throw new Error(`Amazon erro: ${resJson.Output.message || resJson.Output.__type}`);
    }
  } catch (e) {
    if (e.message.startsWith('Amazon erro:')) throw e;
  }

  console.log('[editNote] Nota salva com sucesso no Kindle');
  return { status: 'ok', note: newNote };
}

// Captura screenshot da página atual do browser
async function getScreenshot(userId) {
  const s = getSession(userId);
  if (!s || !s.page) throw new Error('Browser não iniciado');
  const screenshot = await s.page.screenshot({ type: 'jpeg', quality: 70 });
  return screenshot;
}

// Envia interação do usuário para o browser (click, type, keypress)
async function sendInteraction(userId, action) {
  const s = getSession(userId);
  if (!s || !s.page) throw new Error('Browser não iniciado');

  const { page } = s;

  if (action.type === 'click') {
    await page.mouse.click(action.x, action.y);
  } else if (action.type === 'type') {
    await page.keyboard.type(action.text);
  } else if (action.type === 'key') {
    await page.keyboard.press(action.key);
  }

  // Pequeno delay pra dar tempo da página reagir
  await page.waitForTimeout(300);
}

// Verifica se o usuário completou login manual no browser interativo
async function checkManualLogin(userId) {
  const s = getSession(userId);
  if (!s || !s.page) throw new Error('Browser não iniciado');

  const { page, context } = s;

  try {
    const url = page.url();

    // Ainda na página de login — não interrompe
    if (url.includes('/ap/signin') || url.includes('/ap/') || url.includes('/ap/cvf') || url.includes('/ap/mfa')) {
      return { status: 'waiting_manual_login' };
    }

    // Se já saiu do login, tenta ir pra biblioteca
    if (!url.includes('/kindle-library')) {
      await page.goto(`${CLOUD_READER_URL}/kindle-library`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await page.waitForTimeout(2000);
    }

    const finalUrl = page.url();
    if (finalUrl.includes('/kindle-library') && !finalUrl.includes('signin')) {
      console.log(`[${userId}] Login manual completado!`);
      const sessionState = await context.storageState();
      return { status: 'logged_in', sessionState, adpToken: s.adpToken };
    }

    return { status: 'waiting_manual_login' };
  } catch {
    return { status: 'waiting_manual_login' };
  }
}

async function closeBrowser(userId) {
  const s = getSession(userId);
  if (s && s.browser) {
    try {
      await s.browser.close();
    } catch {}
    userSessions.delete(userId);
  }
}

async function isBrowserOpen(userId) {
  const s = getSession(userId);
  return s !== null && s.browser !== null && s.page !== null;
}

module.exports = { openLogin, submitOTP, checkManualLogin, getScreenshot, sendInteraction, scrapeAll, closeBrowser, editNote, isBrowserOpen, getSyncProgress };
