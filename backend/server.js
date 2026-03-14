const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { openLogin, submitOTP, checkManualLogin, getScreenshot, sendInteraction, scrapeAll, closeBrowser, editNote, getSyncProgress } = require('./scraper');
const { stmts } = require('./db');
const { hashPassword, comparePassword, generateToken, authMiddleware } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend estático
app.use(express.static(path.join(__dirname, '..', 'public')));

// ========== CAPTURA DE COOKIES VIA BOOKMARKLET ==========
// Recebe cookies da Amazon via GET (bookmarklet redireciona pra cá)
app.get('/api/capture-cookies', async (req, res) => {
  const { cookies: cookieStr, token } = req.query;
  if (!cookieStr || !token) {
    return res.status(400).send('<h2>Erro: parâmetros ausentes</h2>');
  }

  // Valida token JWT
  let userId;
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'kindle-mvp-secret-key-change-in-production');
    userId = decoded.userId;
  } catch {
    return res.status(401).send('<h2>Erro: token inválido ou expirado</h2>');
  }

  // Converte cookies para storageState
  const cookiePairs = cookieStr.split(';').map(c => c.trim()).filter(Boolean);
  const cookies = cookiePairs.map(pair => {
    const [name, ...rest] = pair.split('=');
    return {
      name: name.trim(),
      value: rest.join('='),
      domain: '.amazon.com.br',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    };
  });

  const sessionData = { cookies, origins: [] };
  stmts.upsertAmazonSession.run(
    uuidv4(), userId,
    JSON.stringify(sessionData),
    '',
  );

  // Retorna página de sucesso que fecha a aba
  res.send(`<!DOCTYPE html>
<html><head><title>KindleSync</title>
<style>body{background:#0d1117;color:#3fb950;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:20px;font-weight:bold;}</style>
</head><body>
<div>Cookies capturados com sucesso! Fechando...</div>
<script>
  if (window.opener) window.opener.postMessage('amazon_login_done', '*');
  setTimeout(() => window.close(), 2000);
</script>
</body></html>`);
});

// ========== AUTH ROUTES (públicas) ==========

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  }

  const existing = stmts.getUserByEmail.get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email já cadastrado' });
  }

  const id = uuidv4();
  const passwordHash = hashPassword(password);
  stmts.createUser.run(id, email, passwordHash, name || '');

  const token = generateToken(id);
  res.json({ token, user: { id, email, name: name || '' } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }

  const user = stmts.getUserByEmail.get(email);
  if (!user || !comparePassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email ou senha incorretos' });
  }

  const token = generateToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = stmts.getUserById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// ========== ROTAS PROTEGIDAS ==========

// Login Amazon headless com email/senha
app.post('/api/login', authMiddleware, async (req, res) => {
  try {
    const { amazonEmail, amazonPassword } = req.body;
    const session = stmts.getAmazonSession.get(req.userId);
    const sessionData = session ? session.session_data : null;

    const result = await openLogin(req.userId, sessionData, amazonEmail, amazonPassword);

    // Se logou, salva a sessão Amazon no DB
    if (result.status === 'logged_in' && result.sessionState) {
      stmts.upsertAmazonSession.run(
        uuidv4(), req.userId,
        JSON.stringify(result.sessionState),
        result.adpToken || '',
      );
    }

    res.json({ status: result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submete código OTP (2FA)
app.post('/api/login/otp', authMiddleware, async (req, res) => {
  try {
    const { otpCode } = req.body;
    if (!otpCode) return res.status(400).json({ error: 'Código é obrigatório' });

    const result = await submitOTP(req.userId, otpCode);

    if (result.status === 'logged_in' && result.sessionState) {
      stmts.upsertAmazonSession.run(
        uuidv4(), req.userId,
        JSON.stringify(result.sessionState),
        result.adpToken || '',
      );
    }

    res.json({ status: result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verifica se login manual foi completado (modo interativo)
app.post('/api/login/check', authMiddleware, async (req, res) => {
  try {
    const result = await checkManualLogin(req.userId);

    if (result.status === 'logged_in' && result.sessionState) {
      stmts.upsertAmazonSession.run(
        uuidv4(), req.userId,
        JSON.stringify(result.sessionState),
        result.adpToken || '',
      );
    }

    res.json({ status: result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Importa cookies do browser do usuário para criar sessão
app.post('/api/login/cookies', authMiddleware, async (req, res) => {
  try {
    const { cookies: cookieStr } = req.body;
    if (!cookieStr) return res.status(400).json({ error: 'Cookies não fornecidos' });

    // Converte string de cookies para formato storageState
    const cookiePairs = cookieStr.split(';').map(c => c.trim()).filter(Boolean);
    const cookies = cookiePairs.map(pair => {
      const [name, ...rest] = pair.split('=');
      return {
        name: name.trim(),
        value: rest.join('='),
        domain: '.amazon.com.br',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'None',
      };
    });

    const sessionData = { cookies, origins: [] };
    stmts.upsertAmazonSession.run(
      uuidv4(), req.userId,
      JSON.stringify(sessionData),
      '',
    );

    // Tenta usar esses cookies no Playwright pra validar e completar a sessão
    const session = stmts.getAmazonSession.get(req.userId);
    const result = await openLogin(req.userId, session.session_data);

    if (result.status === 'logged_in' && result.sessionState) {
      stmts.upsertAmazonSession.run(
        uuidv4(), req.userId,
        JSON.stringify(result.sessionState),
        result.adpToken || '',
      );
    }

    res.json({ status: result.status === 'logged_in' ? 'ok' : result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Screenshot do browser remoto (para login interativo)
app.get('/api/login/screenshot', authMiddleware, async (req, res) => {
  try {
    const screenshot = await getScreenshot(req.userId);
    res.set('Content-Type', 'image/jpeg');
    res.send(screenshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envia interação para o browser remoto (click, type, key)
app.post('/api/login/interact', authMiddleware, async (req, res) => {
  try {
    await sendInteraction(req.userId, req.body);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scraping de livros e highlights
app.post('/api/sync', authMiddleware, async (req, res) => {
  try {
    const books = await scrapeAll(req.userId);
    await closeBrowser(req.userId);

    // Salva sessão atualizada
    if (books._sessionState) {
      const existingSession = stmts.getAmazonSession.get(req.userId);
      stmts.upsertAmazonSession.run(
        existingSession ? existingSession.id : uuidv4(),
        req.userId,
        JSON.stringify(books._sessionState),
        books._adpToken || '',
      );
    }

    // Persiste livros e highlights no DB
    const bookList = books.filter(b => b.asin);
    for (const book of bookList) {
      const bookId = `${req.userId}_${book.asin}`;
      stmts.upsertBook.run(
        bookId, req.userId, book.asin,
        book.title, book.author, book.cover,
        book.progress ? JSON.stringify(book.progress) : null,
        book._revision || '',
      );

      // Substitui highlights do livro
      stmts.deleteHighlightsByBook.run(bookId);
      for (const h of book.highlights) {
        stmts.insertHighlight.run(
          uuidv4(), bookId, req.userId,
          h.text, h.note || '', h.color || 'yellow', h.type || 'highlight',
          h.page || '', h.chapter || '', h.location || '',
          h._position, h._start, h._end,
          h._guid || '', h._dsn || '', h._positionType || 'YJBinary',
        );
      }
    }

    res.json({ status: 'ok', books: loadBooksFromDB(req.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista livros do usuário (do DB)
app.get('/api/books', authMiddleware, (req, res) => {
  res.json(loadBooksFromDB(req.userId));
});

// Progresso do sync
app.get('/api/sync/progress', authMiddleware, (req, res) => {
  res.json(getSyncProgress(req.userId));
});

// Editar nota de um highlight
app.put('/api/books/:bookIndex/highlights/:highlightIndex/note', authMiddleware, async (req, res) => {
  const bi = parseInt(req.params.bookIndex);
  const hi = parseInt(req.params.highlightIndex);
  const { note } = req.body;

  const books = loadBooksFromDB(req.userId);
  if (!books[bi] || !books[bi].highlights[hi]) {
    return res.status(404).json({ error: 'Highlight não encontrado' });
  }

  const highlight = books[bi].highlights[hi];
  const book = books[bi];

  // Carrega sessão Amazon pra editar nota no Kindle
  const session = stmts.getAmazonSession.get(req.userId);

  try {
    await editNote(book.asin, hi, note || '', {
      _end: highlight._end,
      _guid: highlight._guid,
      _position: highlight._position,
      _positionType: highlight._positionType,
    }, { _revision: book._revision }, session);
    stmts.updateHighlightNote.run(note || '', highlight.id);
    res.json({ status: 'ok', note: note || '' });
  } catch (err) {
    // Salva localmente mesmo se falhar na Amazon
    stmts.updateHighlightNote.run(note || '', highlight.id);
    res.json({ status: 'ok', note: note || '', warning: 'Salvo localmente. ' + err.message });
  }
});

// Verifica se tem sessão Amazon salva
app.get('/api/amazon-session', authMiddleware, (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
  });
  const session = stmts.getAmazonSession.get(req.userId);
  res.json({ hasSession: !!session });
});

app.post('/api/close', authMiddleware, async (req, res) => {
  await closeBrowser(req.userId);
  res.json({ status: 'closed' });
});

// Helper: carrega livros + highlights do DB
function loadBooksFromDB(userId) {
  const books = stmts.getBooksByUser.all(userId);
  return books.map(b => ({
    asin: b.asin,
    title: b.title,
    author: b.author,
    cover: b.cover,
    progress: b.progress_json ? JSON.parse(b.progress_json) : null,
    _revision: b.revision,
    highlights: stmts.getHighlightsByBook.all(b.id).map(h => ({
      id: h.id,
      text: h.text,
      note: h.note,
      color: h.color,
      type: h.type,
      page: h.page,
      chapter: h.chapter,
      location: h.location,
      _position: h.position,
      _start: h.start_pos,
      _end: h.end_pos,
      _guid: h.guid,
      _dsn: h.dsn,
      _positionType: h.position_type,
    })),
  }));
}

app.listen(PORT, () => {
  console.log(`KindleSync Backend rodando em http://localhost:${PORT}`);
});
