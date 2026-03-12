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

  // 1) Navega para a biblioteca do Cloud Reader
  console.log('Navegando para Cloud Reader Library...');
  await page.goto(`${CLOUD_READER_URL}/kindle-library`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(5000);

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
      await page.goto(`${CLOUD_READER_URL}/?asin=${asin}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(8000);

      // Fecha alert "Most Recent Page Read" se aparecer
      try {
        const alertBtn = await page.$('ion-alert button');
        if (alertBtn) await alertBtn.click();
        await page.waitForTimeout(500);
      } catch {}

      // Clica no centro para mostrar a toolbar
      await page.mouse.click(400, 300);
      await page.waitForTimeout(1000);

      // Extrai progresso de leitura do footer
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

      // Abre o painel de Annotations via JS (evita timeout de click)
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="top_menu_notebook"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);

      // Debug: dump HTML dos primeiros wrappers para diagnosticar notas
      const debugDump = await page.evaluate(() => {
        const wrappers = document.querySelectorAll('.notebook-editable-item-wrapper');
        const dump = [];
        for (let i = 0; i < Math.min(3, wrappers.length); i++) {
          dump.push(wrappers[i].innerHTML.substring(0, 500));
        }
        return dump;
      });
      console.log(`  Debug wrappers (${debugDump.length}):`);
      debugDump.forEach((d, i) => console.log(`    [${i}] ${d.substring(0, 200)}`));

      // Extrai highlights do painel de annotations
      const highlights = await page.evaluate(() => {
        const results = [];
        const chapters = document.querySelectorAll('.notebook-chapter');

        chapters.forEach(chapter => {
          const chapterTitle = chapter.querySelector('.notebook-chapter--title')?.textContent.trim() || '';

          chapter.querySelectorAll('.notebook-editable-item-wrapper').forEach(wrapper => {
            const titleEl = wrapper.querySelector('p.grouped-annotation_title');
            const textEl = wrapper.querySelector('p.notebook-editable-item-black');
            const colorEl = wrapper.querySelector('[class*="notebook-editable-item__highlight-color--"]');
            // Busca nota com seletores amplos
            const noteEl = wrapper.querySelector('.notebook-editable-item--note, [class*="note-text"], p.notebook-editable-item-gray, .notebook-editable-item-note');

            if (!textEl) return;

            const headerText = titleEl ? titleEl.textContent.trim() : '';
            const text = textEl.textContent.trim();
            if (!text) return;

            // Extrai tipo e pagina do header (ex: "Highlight • Page 10", "Note • Page 15")
            let type = 'highlight';
            if (/^Note/i.test(headerText) || /^Nota/i.test(headerText)) return; // Ignora notas standalone
            else if (/^Bookmark/i.test(headerText) || /^Marcador/i.test(headerText)) type = 'bookmark';

            let page = '';
            const pageMatch = headerText.match(/Page\s+(\d+)/i) || headerText.match(/P[aá]g[a-z]*\.?\s+(\d+)/i);
            if (pageMatch) page = pageMatch[1];

            // Extrai cor
            let color = 'yellow';
            if (colorEl) {
              const cls = colorEl.className || '';
              const colorMatch = cls.match(/highlight-color--(\w+)/);
              if (colorMatch) color = colorMatch[1];
            }

            // Nota (se existir) — tenta varios seletores
            let note = '';
            if (noteEl) {
              note = noteEl.textContent.trim();
            } else {
              // Fallback: busca o segundo <p> com texto dentro do wrapper (o primeiro e o highlight)
              const allPs = wrapper.querySelectorAll('p');
              for (const p of allPs) {
                if (p === textEl || p === titleEl) continue;
                if (p.classList.contains('grouped-annotation_title')) continue;
                const pText = p.textContent.trim();
                if (pText && pText !== text) {
                  note = pText;
                  break;
                }
              }
            }

            results.push({
              text, note, color, type, page, chapter: chapterTitle,
              location: headerText, locationNum: '',
            });
          });
        });

        return results;
      });

      bookList[i].highlights = highlights.map(h => ({
        text: h.text,
        note: h.note,
        location: h.location,
        color: h.color,
        type: h.type,
        page: h.page,
        locationNum: '',
        date: '',
        chapter: h.chapter,
      }));

      const notesCount = bookList[i].highlights.filter(h => h.note).length;
      console.log(`  ${bookList[i].highlights.length} destaques encontrados (${notesCount} com notas)`);
    } catch (err) {
      console.log(`  Erro: ${err.message}`);
      bookList[i].highlights = [];
    }
  }

  await saveSession();
  return bookList;
}

async function editNote(asin, highlightIndex, newNote) {
  if (!page) throw new Error('Browser não iniciado');

  // 1) Abre o livro no Cloud Reader
  console.log(`[editNote] Abrindo livro ASIN=${asin}...`);
  await page.goto(`${CLOUD_READER_URL}/?asin=${asin}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(8000);

  // Fecha alert "Most Recent Page Read" se aparecer
  try {
    const alertBtn = await page.$('ion-alert button');
    if (alertBtn) await alertBtn.click();
    await page.waitForTimeout(500);
  } catch {}

  // 2) Clica no centro para mostrar a toolbar
  await page.mouse.click(400, 300);
  await page.waitForTimeout(1000);

  // 3) Abre o painel de Annotations (Notebook)
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="top_menu_notebook"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(3000);

  // 4) Encontra o highlight pelo índice (somente highlights, ignorando notas standalone)
  const wrappers = await page.$$('.notebook-chapter .notebook-editable-item-wrapper');
  let validIndex = 0;
  let targetWrapper = null;

  for (const wrapper of wrappers) {
    const headerText = await wrapper.$eval(
      'p.grouped-annotation_title',
      el => el.textContent.trim()
    ).catch(() => '');

    // Ignora notas standalone (mesmo filtro do scrapeAll)
    if (/^Note/i.test(headerText) || /^Nota/i.test(headerText)) continue;

    // Verifica se tem texto de highlight
    const hasText = await wrapper.$('p.notebook-editable-item-black').catch(() => null);
    if (!hasText) continue;

    if (validIndex === highlightIndex) {
      targetWrapper = wrapper;
      break;
    }
    validIndex++;
  }

  if (!targetWrapper) throw new Error(`Highlight índice ${highlightIndex} não encontrado no painel de annotations`);

  // 5) Clica no wrapper para selecionar/abrir edição de nota
  console.log(`[editNote] Encontrou highlight no índice ${highlightIndex}, editando nota...`);

  // Tenta encontrar botão de editar nota ou área clicável para nota
  const editBtn = await targetWrapper.$('button[class*="note"], [data-testid*="note"], [class*="edit-note"], [class*="add-note"]');
  if (editBtn) {
    await editBtn.click();
    await page.waitForTimeout(1000);
  } else {
    // Clica no wrapper para abrir opções
    await targetWrapper.click();
    await page.waitForTimeout(1000);
  }

  // 6) Procura textarea/input de nota dentro do wrapper ou na página
  let textarea = await targetWrapper.$('textarea, input[type="text"], [contenteditable="true"]');
  if (!textarea) {
    // Procura globalmente (pode ser um modal/overlay)
    textarea = await page.$('.notebook-note-editor textarea, .notebook-note-input textarea, [class*="note-editor"] textarea, [class*="note-input"] textarea, textarea[class*="note"]');
  }
  if (!textarea) {
    // Tenta encontrar qualquer textarea visível na página
    textarea = await page.$('textarea');
  }

  if (!textarea) {
    // Debug: lista elementos interativos do wrapper
    const debugInfo = await targetWrapper.evaluate(el => el.innerHTML.substring(0, 500));
    console.log(`[editNote] Debug wrapper HTML: ${debugInfo}`);
    throw new Error('Campo de edição da nota não encontrado no Cloud Reader');
  }

  // 7) Limpa e digita a nova nota
  await textarea.click({ clickCount: 3 });
  await page.waitForTimeout(200);
  await textarea.fill(newNote || '');
  await page.waitForTimeout(500);

  // 8) Salva — procura botão de salvar
  const saveBtn = await page.$('button:has-text("Save"), button:has-text("Salvar"), button:has-text("Done"), button:has-text("Concluído"), [class*="save-note"], [data-testid*="save"]');

  if (saveBtn) {
    await saveBtn.click();
    await page.waitForTimeout(1000);
    console.log('[editNote] Nota salva via botão');
  } else {
    // Fallback: pressiona Enter ou Tab para confirmar
    await textarea.press('Tab');
    await page.waitForTimeout(500);
    console.log('[editNote] Nota salva via Tab (fallback)');
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
