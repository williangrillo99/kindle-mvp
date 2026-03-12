const express = require('express');
const cors = require('cors');
const path = require('path');
const { openLogin, waitForLogin, scrapeAll, closeBrowser, editNote, getSyncProgress } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3001;

let booksData = [];

app.use(cors());
app.use(express.json());

// Serve frontend estático
app.use(express.static(path.join(__dirname, '..', 'public')));

// Abre Chrome real com login da Amazon
app.post('/api/login', async (req, res) => {
  try {
    await openLogin();
    res.json({ status: 'login_opened' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Polling — verifica se login foi concluído
app.get('/api/login/status', async (req, res) => {
  try {
    const result = await waitForLogin(5000);
    res.json(result);
  } catch {
    res.json({ status: 'waiting' });
  }
});

// Scraping de livros e highlights
app.post('/api/sync', async (req, res) => {
  try {
    booksData = await scrapeAll();
    await closeBrowser();
    res.json({ status: 'ok', books: booksData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/books', (req, res) => {
  res.json(booksData);
});

// Progresso do sync
app.get('/api/sync/progress', (req, res) => {
  res.json(getSyncProgress());
});

// Editar nota de um highlight no Kindle
app.put('/api/books/:bookIndex/highlights/:highlightIndex/note', async (req, res) => {
  const bi = parseInt(req.params.bookIndex);
  const hi = parseInt(req.params.highlightIndex);
  const { note } = req.body;

  if (!booksData[bi] || !booksData[bi].highlights[hi]) {
    return res.status(404).json({ error: 'Highlight não encontrado' });
  }

  try {
    await editNote(booksData[bi].asin, hi, note || '');
    booksData[bi].highlights[hi].note = note || '';
    res.json({ status: 'ok', note: booksData[bi].highlights[hi].note });
  } catch (err) {
    // Salva localmente mesmo se falhar na Amazon
    booksData[bi].highlights[hi].note = note || '';
    res.json({ status: 'ok', note: booksData[bi].highlights[hi].note, warning: 'Salvo localmente. ' + err.message });
  }
});

app.post('/api/close', async (req, res) => {
  await closeBrowser();
  res.json({ status: 'closed' });
});

app.listen(PORT, () => {
  console.log(`KindleSync Backend rodando em http://localhost:${PORT}`);
});
