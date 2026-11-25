const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS streamers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT,
  channel_id TEXT,
  channel_href TEXT,
  status TEXT DEFAULT '크리에이터',
  memo TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monthly_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  year_month TEXT NOT NULL,
  broadcast_hours REAL,
  avg_viewers INTEGER,
  max_viewers INTEGER,
  collected_at TEXT DEFAULT (datetime('now')),
  UNIQUE(streamer_id, year_month)
);
`);

module.exports = db;
