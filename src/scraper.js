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
        const rawId = el.getAttribute('id') || '';
        // ID pode ser "kp-notebook-library-each-book-B0XXXXXX" ou "B0XXXXXX"
        const asin = el.getAttribute('data-asin')
          || rawId.replace(/^kp-notebook-library-each-book-/, '').replace(/^kp-notebook-library-/, '')
          || '';

        return {
          asin,
          title: titleEl ? titleEl.textContent.trim() : 'Sem título',
          author: authorEl ? authorEl.textContent.trim() : 'Autor desconhecido',
          cover: imgEl ? imgEl.src : '',
          highlights: [],
        };
      })
  );

  // Log ASINs para debug
  books.forEach((b, idx) => console.log(`  Livro ${idx}: ASIN="${b.asin}" - ${b.title}`));

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

      // Extrai highlights E notas standalone (com capitulo)
      const extractResult = await page.evaluate(() => {
        const results = [];
        const debug = [];
        const seen = new Set();
        let currentChapter = '';

        // Percorre TODOS os filhos de #kp-notebook-annotations em ordem
        // para rastrear headers de capitulo e associar a cada highlight
        const annotationsRoot = document.querySelector('#kp-notebook-annotations');
        // Debug: mostra filhos diretos de #kp-notebook-annotations para descobrir estrutura
        const chapterDebug = [];
        if (annotationsRoot) {
          const directChildren = annotationsRoot.children;
          for (let i = 0; i < Math.min(directChildren.length, 15); i++) {
            const child = directChildren[i];
            chapterDebug.push({
              tag: child.tagName,
              id: child.id || '',
              classes: child.className || '',
              text: child.textContent.trim().substring(0, 150),
            });
          }
        }

        // Encontra headers de capitulo e mapeia cada container ao seu capitulo
        const chapterMap = new Map();
        let chapter = '';
        // Percorre filhos diretos em ordem para rastrear capitulos
        if (annotationsRoot) {
          const directChildren = annotationsRoot.children;
          for (let i = 0; i < directChildren.length; i++) {
            const el = directChildren[i];
            // Checa se eh um header de secao/capitulo (nao eh um container de anotacao)
            const isAnnotation = el.id && el.id.startsWith('annotationContainer');
            const hasAnnotationHeader = el.querySelector && (el.querySelector('#annotationHighlightHeader') || el.querySelector('#annotationNoteHeader'));

            if (!isAnnotation && !hasAnnotationHeader) {
              const text = el.textContent.trim();
              if (text && text.length > 1 && !text.match(/^(Yellow|Blue|Pink|Orange)\s+highlight/i) &&
                  !text.match(/^(Destaque|Nota|Marcador)/i)) {
                chapter = text;
              }
            }
            // Associa containers de anotacao (diretos ou nested) ao capitulo atual
            if (isAnnotation) {
              chapterMap.set(el, chapter);
            }
            // Tambem checa sub-containers
            const subContainers = el.querySelectorAll ? el.querySelectorAll('[id^="annotationContainer"]') : [];
            subContainers.forEach(sc => chapterMap.set(sc, chapter));
          }
        }

        // Pega containers validos
        const containers = annotationsRoot ? annotationsRoot.querySelectorAll('[id^="annotationContainer"], .kp-notebook-row-separator, .a-row') : [];
        const validContainers = [];
        containers.forEach(c => {
          if (c.querySelector('#annotationHighlightHeader') || c.querySelector('#annotationNoteHeader')) {
            validContainers.push(c);
          }
        });

        const targets = validContainers.length > 0 ? validContainers : [];

        // Abordagem por containers
        targets.forEach((container) => {
          currentChapter = chapterMap.get(container) || '';
          const highlightEl = container.querySelector('#highlight');
          const noteEl = container.querySelector('#note');
          const locationEl = container.querySelector('#annotationHighlightHeader') || container.querySelector('#annotationNoteHeader');
          const colorEl = container.querySelector('[class*="kp-notebook-highlight-"]');

          const highlightText = highlightEl ? highlightEl.textContent.trim() : '';
          const noteText = noteEl ? noteEl.textContent.trim() : '';

          // Filtra placeholders de nota
          const notePlaceholders = ['Add a note', 'Adicionar uma nota', 'Adicionar anotação', ''];
          const note = notePlaceholders.includes(noteText) ? '' : noteText;

          // Se nao tem highlight nem nota real, ignora
          if (!highlightText && !note) return;

          // Deduplicacao
          const dedupeKey = highlightText || note;
          if (seen.has(dedupeKey)) return;
          seen.add(dedupeKey);

          let color = 'yellow';
          if (colorEl) {
            const cls = colorEl.className || '';
            const match = cls.match(/kp-notebook-highlight-(\w+)/);
            if (match && match[1] !== 'color') color = match[1];
          }

          const headerText = locationEl ? locationEl.textContent.trim() : '';

          // Debug: primeiros 5 para o terminal Node
          if (results.length < 5) {
            debug.push({
              headerText,
              chapter: currentChapter,
              highlightText: highlightText.substring(0, 100),
              noteRaw: noteText,
              hasHighlightEl: !!highlightEl,
              hasNoteEl: !!noteEl,
              containerHTML: container.innerHTML.substring(0, 1500),
            });
          }

          // Tipo de anotacao
          let type = 'highlight';
          if (!highlightText && note) {
            type = 'note';
          } else if (/\bNote\b/i.test(headerText) || /\bNota\b/i.test(headerText)) {
            type = 'note';
          } else if (/\bBookmark\b/i.test(headerText) || /\bMarcador\b/i.test(headerText)) {
            type = 'bookmark';
          }

          // Pagina
          let pageNum = '';
          const pageMatch = headerText.match(/(?:Page|Página|Pág\.?|Pag\.?)\s+(\d+)/i);
          if (pageMatch) pageNum = pageMatch[1];

          // Location number
          let locationNum = '';
          const locMatch = headerText.match(/(?:Location|Posição|Local|Loc\.?)\s*:?\s*([\d-]+)/i);
          if (locMatch) locationNum = locMatch[1];

          if (!pageNum && !locationNum) {
            const numMatch = headerText.match(/(\d+[\d-]*)/);
            if (numMatch) locationNum = numMatch[1];
          }

          // Data
          let date = '';
          const allContainerText = container.textContent || '';
          const dateMatch = allContainerText.match(/(?:Added on|Adicionado em)\s+(.+?)(?:\n|$)/i)
            || allContainerText.match(/(\w+day,\s+\w+\s+\d{1,2},\s+\d{4})/i)
            || allContainerText.match(/(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i)
            || allContainerText.match(/((?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+\d{1,2},?\s+\d{4})/i)
            || allContainerText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i);
          if (dateMatch) date = dateMatch[1].trim();

          results.push({
            text: highlightText || note,
            note: highlightText ? note : '',
            location: headerText,
            color,
            type,
            page: pageNum,
            locationNum,
            date,
            chapter: currentChapter,
          });
        });

        // Fallback: se nao encontrou containers, usa abordagem antiga por #highlight
        if (results.length === 0) {
          const highlightEls = document.querySelectorAll('#kp-notebook-annotations #highlight');
          highlightEls.forEach((el) => {
            const text = el.textContent.trim();
            if (!text || seen.has(text)) return;
            seen.add(text);

            let container = el.parentElement;
            for (let depth = 0; depth < 10 && container; depth++) {
              if (container.querySelector('#annotationHighlightHeader')) break;
              if (container.id === 'kp-notebook-annotations') { container = el.parentElement; break; }
              container = container.parentElement;
            }

            const noteEl = container?.querySelector('#note');
            const noteText = noteEl ? noteEl.textContent.trim() : '';
            const locationEl = container?.querySelector('#annotationHighlightHeader');
            const headerText = locationEl ? locationEl.textContent.trim() : '';
            const notePlaceholders = ['Add a note', 'Adicionar uma nota', 'Adicionar anotação', ''];
            const note = notePlaceholders.includes(noteText) ? '' : noteText;

            results.push({
              text,
              note,
              location: headerText,
              color: 'yellow',
              type: 'highlight',
              page: '',
              locationNum: '',
              date: '',
            });
          });
        }

        return { results, debug, chapterDebug };
      });

      books[i].highlights = extractResult.results;

      // Log debug no terminal Node (so no primeiro livro)
      if (i === 0) {
        if (extractResult.chapterDebug && extractResult.chapterDebug.length > 0) {
          console.log('  === DEBUG: Filhos diretos de #kp-notebook-annotations ===');
          extractResult.chapterDebug.forEach((c, idx) => {
            console.log(`  [${idx}] <${c.tag}> id="${c.id}" class="${c.classes}" text="${c.text}"`);
          });
          console.log('  === FIM CHAPTER DEBUG ===');
        }
        if (extractResult.debug.length > 0) {
          console.log('  === DEBUG: Formato dos highlights ===');
          extractResult.debug.forEach((d, idx) => {
            console.log(`  [${idx}] header: "${d.headerText}" | chapter: "${d.chapter}"`);
            console.log(`  [${idx}] hasHighlightEl: ${d.hasHighlightEl}, hasNoteEl: ${d.hasNoteEl}`);
            console.log(`  [${idx}] highlightText: "${d.highlightText}"`);
            console.log(`  [${idx}] noteRaw: "${d.noteRaw}"`);
            console.log(`  [${idx}] containerHTML:`, d.containerHTML.substring(0, 500));
            console.log('  ---');
          });
          console.log('  === FIM DEBUG ===');
        }
      }

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
