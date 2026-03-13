const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let browser = null;
let context = null;
let page = null;
let syncProgress = { current: 0, total: 0, bookTitle: '' };

const CLOUD_READER_URL = 'https://ler.amazon.com.br';
const LOGIN_URL = 'https://www.amazon.com.br/ap/signin?openid.pape.max_auth_age=1209600&openid.return_to=https%3A%2F%2Fler.amazon.com.br%2Fkindle-library&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=amzn_kindle_mykindle_br&openid.mode=checkid_setup&language=pt_BR&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_kindle_mykindle_br&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0';
const SESSION_FILE = path.join(__dirname, '..', '.session.json');

function getSyncProgress() {
  return syncProgress;
}

function hasSavedSession() {
  return fs.existsSync(SESSION_FILE);
}

async function openLogin() {
  if (browser) return;

  browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const contextOptions = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  };

  // Restaura sessao salva se existir
  if (hasSavedSession()) {
    try {
      contextOptions.storageState = SESSION_FILE;
      console.log('Restaurando sessao salva...');
    } catch {
      console.log('Sessao salva invalida, ignorando...');
    }
  }

  context = await browser.newContext(contextOptions);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  page = await context.newPage();

  // Detecta quando o usuario fecha o browser
  browser.on('disconnected', () => {
    console.log('Browser fechado pelo usuario');
    browser = null;
    context = null;
    page = null;
  });

  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  return { status: 'login_opened' };
}

async function waitForLogin(timeoutMs = 120000) {
  // Browser foi fechado pelo usuario
  if (!page || !browser) {
    return { status: 'browser_closed' };
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Verifica se browser foi fechado durante o polling
    if (!page || !browser) {
      return { status: 'browser_closed' };
    }

    try {
      const url = page.url();
      if (url.includes('ler.amazon') && url.includes('/kindle-library') && !url.includes('signin') && !url.includes('/ap/')) {
        await page.waitForTimeout(2000);
        await saveSession();
        return { status: 'logged_in' };
      }
      await page.waitForTimeout(1000);
    } catch {
      // page.url() falha se o browser foi fechado
      return { status: 'browser_closed' };
    }
  }

  throw new Error('Timeout esperando login');
}

async function saveSession() {
  if (!context) return;
  try {
    const state = await context.storageState();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
    console.log('Sessao salva em', SESSION_FILE);
  } catch (err) {
    console.error('Erro ao salvar sessao:', err.message);
  }
}

async function scrapeAll() {
  if (!page) throw new Error('Browser não iniciado');

  // Captura dados brutos de annotations e x-adp-session-token
  const annotationsCache = {};
  const revisionCache = {};
  let adpSessionToken = '';
  page.on('request', req => {
    const url = req.url();
    // Captura x-adp-session-token de qualquer request
    const adp = req.headers()['x-adp-session-token'];
    if (adp) adpSessionToken = adp;
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
          console.log(`[NET] Cached ${body.annotations.length} annotations for ${asinMatch[1]} (revision=${revisionMatch ? revisionMatch[1] : 'N/A'})`);
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
  // Espera o JSON da biblioteca carregar (max 10s)
  try {
    await page.waitForSelector('#itemViewResponse', { timeout: 10000 });
  } catch {
    await page.waitForTimeout(2000);
  }

  // Extrai lista de livros do JSON embutido (#itemViewResponse)
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
  syncProgress = { current: 0, total: bookList.length, bookTitle: '' };

  // 2) Para cada livro: abre no Cloud Reader e extrai dados
  for (let i = 0; i < bookList.length; i++) {
    const asin = bookList[i].asin;
    if (!asin) continue;

    syncProgress = { current: i + 1, total: bookList.length, bookTitle: bookList[i].title };
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
      // Espera os highlights carregarem
      try {
        await page.waitForSelector('#annotation-scroller, .kp-notebook-annotations-container, .a-row.kp-notebook-row', { timeout: 10000 });
      } catch {
        await page.waitForTimeout(3000);
      }

      // Extrai highlights da página do Notebook
      const highlights = await page.evaluate(() => {
        const results = [];

        // Tenta seletores do Kindle Notebook (read.amazon.com/notebook)
        const annotations = document.querySelectorAll('#highlight, .kp-notebook-highlight, [id^="highlight-"]');
        if (annotations.length > 0) {
          annotations.forEach(el => {
            const text = el.textContent.trim();
            if (!text) return;
            // Busca nota associada (próximo sibling ou dentro do mesmo container)
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

      // Enriquece highlights com dados da API (position, guid, dsn, texto completo)
      const apiAnnotations = annotationsCache[asin] || [];
      const apiHighlights = apiAnnotations.filter(a => a.type === 'kindle.highlight');
      const apiNotes = apiAnnotations.filter(a => a.type === 'kindle.note');

      bookList[i]._revision = revisionCache[asin] || '';

      // Usa highlights do DOM como base e enriquece com dados da API (guid, position, nota)
      // DOM tem texto mais completo; API tem metadados para edição de notas
      bookList[i].highlights = highlights.map((h) => {
        // Busca match na API pelo início do texto
        const apiMatch = apiHighlights.find(a => {
          if (!a.context || !h.text) return false;
          const apiSnippet = a.context.substring(0, 60);
          return h.text.includes(apiSnippet) || apiSnippet.includes(h.text.substring(0, 60));
        });
        // Usa o texto mais longo entre DOM e API
        let text = h.text;
        if (apiMatch && apiMatch.context && apiMatch.context.length > text.length) {
          text = apiMatch.context;
        }
        // Busca nota vinculada na API
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

      // Deduplica highlights pelo texto (primeiros 80 chars)
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

  // Salva o x-adp-session-token para uso no editNote
  if (adpSessionToken) {
    const tokenFile = path.join(__dirname, '..', '.adp-token.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ token: adpSessionToken }));
    console.log(`[scrapeAll] ADP session token salvo (${adpSessionToken.substring(0, 30)}...)`);
  }

  await saveSession();
  return bookList;
}

// Edita nota via HTTP usando cookies da sessão (sem browser)
async function editNote(asin, highlightIndex, newNote, highlightData, bookData) {
  console.log(`[editNote] Editando nota via HTTP - ASIN=${asin}, index=${highlightIndex}`);

  if (!highlightData || !highlightData._end || !highlightData._guid) {
    throw new Error('Dados da annotation não encontrados. Faça sync novamente.');
  }

  // Carrega cookies da sessão
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('Sessão não encontrada. Faça login primeiro.');
  }

  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  const cookies = session.cookies || [];

  const cookieStr = cookies
    .filter(c => c.domain.includes('amazon'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  if (!cookieStr) {
    throw new Error('Cookies da Amazon não encontrados na sessão.');
  }

  // Carrega x-adp-session-token
  const tokenFile = path.join(__dirname, '..', '.adp-token.json');
  let adpToken = '';
  if (fs.existsSync(tokenFile)) {
    adpToken = JSON.parse(fs.readFileSync(tokenFile, 'utf-8')).token || '';
  }
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
  console.log(`[editNote] CSRF token: ${csrfToken.substring(0, 30)}...`);

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
  console.log(`[editNote] POST ${updateUrl}`);
  console.log(`[editNote] Body: ${JSON.stringify(body).substring(0, 500)}`);

  const updateRes = await fetch(updateUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
  });

  const responseText = await updateRes.text();
  console.log(`[editNote] Response ${updateRes.status}: ${responseText.substring(0, 500)}`);

  if (!updateRes.ok) {
    throw new Error(`API Amazon retornou ${updateRes.status}: ${responseText.substring(0, 200)}`);
  }

  // Amazon retorna 200 mesmo com erro — checa o body
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

async function isBrowserOpen() {
  return browser !== null && page !== null;
}

async function closeBrowser() {
  if (browser) {
    await saveSession();
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

module.exports = { openLogin, waitForLogin, scrapeAll, closeBrowser, editNote, isBrowserOpen, getSyncProgress };
