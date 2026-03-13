const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'kindle.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS amazon_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    session_data TEXT NOT NULL,
    adp_token TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    asin TEXT NOT NULL,
    title TEXT,
    author TEXT,
    cover TEXT,
    progress_json TEXT,
    revision TEXT,
    synced_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, asin)
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    note TEXT DEFAULT '',
    color TEXT DEFAULT 'yellow',
    type TEXT DEFAULT 'highlight',
    page TEXT,
    chapter TEXT,
    location TEXT,
    position INTEGER,
    start_pos INTEGER,
    end_pos INTEGER,
    guid TEXT,
    dsn TEXT,
    position_type TEXT DEFAULT 'YJBinary',
    synced_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Prepared statements
const stmts = {
  createUser: db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById: db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?'),

  upsertAmazonSession: db.prepare(`
    INSERT INTO amazon_sessions (id, user_id, session_data, adp_token, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET session_data=excluded.session_data, adp_token=excluded.adp_token, updated_at=datetime('now')
  `),
  getAmazonSession: db.prepare('SELECT * FROM amazon_sessions WHERE user_id = ?'),

  upsertBook: db.prepare(`
    INSERT INTO books (id, user_id, asin, title, author, cover, progress_json, revision, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, asin) DO UPDATE SET title=excluded.title, author=excluded.author, cover=excluded.cover,
      progress_json=excluded.progress_json, revision=excluded.revision, synced_at=datetime('now')
  `),
  getBooksByUser: db.prepare('SELECT * FROM books WHERE user_id = ? ORDER BY synced_at DESC'),
  getBookByUserAndAsin: db.prepare('SELECT * FROM books WHERE user_id = ? AND asin = ?'),

  deleteHighlightsByBook: db.prepare('DELETE FROM highlights WHERE book_id = ?'),
  insertHighlight: db.prepare(`
    INSERT INTO highlights (id, book_id, user_id, text, note, color, type, page, chapter, location, position, start_pos, end_pos, guid, dsn, position_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getHighlightsByBook: db.prepare('SELECT * FROM highlights WHERE book_id = ? ORDER BY position ASC, rowid ASC'),
  updateHighlightNote: db.prepare('UPDATE highlights SET note = ? WHERE id = ?'),
};

module.exports = { db, stmts };
