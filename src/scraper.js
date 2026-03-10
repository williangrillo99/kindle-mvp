const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let browser = null;
let context = null;
let page = null;
let syncProgress = { current: 0, total: 0, bookTitle: '' };

const NOTEBOOK_URL = 'https://read.amazon.com/notebook';
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
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
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

  await page.goto(NOTEBOOK_URL, {
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
      if (url.includes('read.amazon') && url.includes('/notebook') && !url.includes('signin') && !url.includes('/ap/')) {
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

  // Garante que está no notebook
  const url = page.url();
  if (!url.includes('/notebook')) {
    await page.goto('https://read.amazon.com/notebook', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  }

  await page.waitForSelector('#kp-notebook-library', { timeout: 15000 });

  // Extrai livros
  const books = await page.$$eval(
    '#kp-notebook-library .kp-notebook-library-each-book',
    (elements) =>
      elements.map((el) => {
        const titleEl = el.querySelector('h2') || el.querySelector('p');
        const authorEl = el.querySelector('p:last-of-type');
        const imgEl = el.querySelector('img');
        const asin = el.getAttribute('id') || el.getAttribute('data-asin') || '';

        return {
          asin: asin.replace('kp-notebook-library-', ''),
          title: titleEl ? titleEl.textContent.trim() : 'Sem título',
          author: authorEl ? authorEl.textContent.trim() : 'Autor desconhecido',
          cover: imgEl ? imgEl.src : '',
          highlights: [],
        };
      })
  );

  syncProgress = { current: 0, total: books.length, bookTitle: '' };

  // Extrai highlights de cada livro
  for (let i = 0; i < books.length; i++) {
    syncProgress = { current: i + 1, total: books.length, bookTitle: books[i].title };
    console.log(`[${i + 1}/${books.length}] Extraindo: ${books[i].title}`);

    // Navega diretamente para as anotacoes do livro pela URL com ASIN
    const asin = books[i].asin;
    await page.goto(`https://read.amazon.com/notebook?asin=${asin}&contentLimitState=&`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    try {
      // Espera as anotacoes carregarem
      await page.waitForSelector('#kp-notebook-annotations', { timeout: 10000 });

      // Scroll ate o final para carregar todos os highlights (lazy loading)
      let prevCount = 0;
      for (let scroll = 0; scroll < 20; scroll++) {
        const currentCount = await page.$$eval('#kp-notebook-annotations #highlight', els => els.length);
        if (currentCount === prevCount && scroll > 0) break;
        prevCount = currentCount;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
      }

      // Dump do HTML para debug (so no primeiro livro)
      if (i === 0) {
        const html = await page.evaluate(() => {
          const ann = document.querySelector('#kp-notebook-annotations');
          if (!ann) return 'N/A';
          // Pega o HTML do primeiro bloco de anotacao
          const firstChild = ann.children[0];
          return firstChild ? firstChild.outerHTML.substring(0, 2000) : ann.innerHTML.substring(0, 2000);
        });
        console.log('  === HTML do primeiro bloco ===');
        console.log(html);
        console.log('  === FIM ===');
      }

      // Extrai highlights
      books[i].highlights = await page.evaluate(() => {
        const results = [];
        const seen = new Set();
        const highlightEls = document.querySelectorAll('#kp-notebook-annotations #highlight');

        highlightEls.forEach((el) => {
          const text = el.textContent.trim();
          if (!text || seen.has(text)) return;
          seen.add(text);

          // Sobe no DOM ate encontrar o container com annotationHighlightHeader
          let container = el.parentElement;
          for (let depth = 0; depth < 10 && container; depth++) {
            if (container.querySelector('#annotationHighlightHeader')) break;
            if (container.id === 'kp-notebook-annotations') { container = el.parentElement; break; }
            container = container.parentElement;
          }

          const noteEl = container?.querySelector('#note');
          const locationEl = container?.querySelector('#annotationHighlightHeader');
          const colorEl = container?.querySelector('[class*="kp-notebook-highlight-"]');

          let color = 'yellow';
          if (colorEl) {
            const cls = colorEl.className || '';
            const match = cls.match(/kp-notebook-highlight-(\w+)/);
            if (match && match[1] !== 'color') color = match[1];
          }

          const note = noteEl ? noteEl.textContent.trim() : '';

          // Header completo para extrair tipo, pagina e data
          const headerText = locationEl ? locationEl.textContent.trim() : '';

          // Log debug dos primeiros 3 highlights para ver formato real
          if (results.length < 3) {
            console.log('[DEBUG header]', headerText);
            // Verifica se ha outros elementos com info de pagina/data
            const allTexts = [];
            container?.querySelectorAll('span, div, p').forEach(child => {
              const t = child.textContent.trim();
              if (t && t.length < 200 && t !== text) allTexts.push(t);
            });
            if (allTexts.length > 0) console.log('[DEBUG container texts]', JSON.stringify(allTexts.slice(0, 10)));
          }

          // Tipo de anotacao (Highlight, Note, Bookmark)
          let type = 'highlight';
          if (/\bNote\b/i.test(headerText) || /\bNota\b/i.test(headerText)) type = 'note';
          else if (/\bBookmark\b/i.test(headerText) || /\bMarcador\b/i.test(headerText)) type = 'bookmark';

          // Pagina — ex: "Page 42", "Página 42", "page 42", "pag 42", "pág. 42"
          let pageNum = '';
          const pageMatch = headerText.match(/(?:Page|Página|Pág\.?|Pag\.?)\s+(\d+)/i);
          if (pageMatch) pageNum = pageMatch[1];

          // Location number — ex: "Location 1234", "Posição 1234", "Loc. 1234"
          let locationNum = '';
          const locMatch = headerText.match(/(?:Location|Posição|Loc\.?)\s+([\d-]+)/i);
          if (locMatch) locationNum = locMatch[1];

          // Data — procura em todo o container, nao apenas no header
          let date = '';
          const allContainerText = container ? container.textContent : '';
          const dateMatch = allContainerText.match(/(?:Added on|Adicionado em)\s+(.+?)(?:\n|$)/i)
            || allContainerText.match(/(\w+day,\s+\w+\s+\d{1,2},\s+\d{4})/i)
            || allContainerText.match(/(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i)
            || allContainerText.match(/((?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+\d{1,2},?\s+\d{4})/i)
            || allContainerText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i);
          if (dateMatch) date = dateMatch[1].trim();

          results.push({
            text,
            note: (note && note !== 'Add a note' && note !== 'Adicionar uma nota') ? note : '',
            location: headerText,
            color,
            type,
            page: pageNum,
            locationNum,
            date,
          });
        });

        return results;
      });

      console.log(`  ${books[i].highlights.length} destaques encontrados`);
    } catch (err) {
      console.log(`  Erro ao extrair: ${err.message}`);
      books[i].highlights = [];
    }
  }

  // Salva sessao apos scraping completo
  await saveSession();

  return books;
}

async function editNote(asin, highlightIndex, newNote) {
  if (!page) throw new Error('Browser não iniciado');

  // Navega para o notebook do livro
  await page.goto(NOTEBOOK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#kp-notebook-library', { timeout: 15000 });

  // Clica no livro pelo ASIN
  const bookSelector = `#kp-notebook-library-${asin} a, [id*="${asin}"] a`;
  const bookLink = await page.$(bookSelector);
  if (!bookLink) throw new Error('Livro não encontrado na página');

  await bookLink.click();
  await page.waitForTimeout(3000);
  await page.waitForSelector('#kp-notebook-annotations', { timeout: 10000 });

  // Pega todos os containers de highlight
  const containers = await page.$$('#kp-notebook-annotations .kp-notebook-row-separator, #kp-notebook-annotations [id^="annotationContainer"]');

  // Filtra só os que têm #highlight (ignora separadores vazios)
  let validIndex = 0;
  let targetContainer = null;
  for (const container of containers) {
    const hasHighlight = await container.$('#highlight');
    if (hasHighlight) {
      if (validIndex === highlightIndex) {
        targetContainer = container;
        break;
      }
      validIndex++;
    }
  }

  if (!targetContainer) throw new Error('Highlight não encontrado na página');

  // Procura o botão de editar nota ou a área de nota clicável
  const noteButton = await targetContainer.$('#editNote, .kp-notebook-note-edit, [id*="noteEdit"], .a-button-text');
  if (noteButton) {
    await noteButton.click();
    await page.waitForTimeout(500);
  }

  // Procura o textarea/input da nota
  const noteInput = await targetContainer.$('textarea, input[type="text"].kp-notebook-note');
  if (!noteInput) {
    // Tenta clicar na área da nota para abrir o editor
    const noteArea = await targetContainer.$('#note, .kp-notebook-note');
    if (noteArea) {
      await noteArea.click();
      await page.waitForTimeout(500);
    }
  }

  // Tenta novamente encontrar o textarea
  const textarea = await targetContainer.$('textarea') || await page.$('#kp-notebook-note-editor textarea, .kp-notebook-note-edit textarea');
  if (!textarea) throw new Error('Campo de edição da nota não encontrado');

  // Limpa e digita a nova nota
  await textarea.click({ clickCount: 3 });
  await page.waitForTimeout(200);

  if (newNote) {
    await textarea.fill(newNote);
  } else {
    await textarea.fill('');
  }

  await page.waitForTimeout(300);

  // Salva — procura botão de salvar
  const saveBtn = await targetContainer.$('button:has-text("Save"), button:has-text("Salvar"), .kp-notebook-note-save, [id*="noteSave"]')
    || await page.$('button:has-text("Save"), button:has-text("Salvar")');

  if (saveBtn) {
    await saveBtn.click();
    await page.waitForTimeout(1000);
  } else {
    // Tenta Tab + Enter como fallback para salvar
    await textarea.press('Tab');
    await page.waitForTimeout(500);
  }

  await saveSession();
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
