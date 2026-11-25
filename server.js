require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const db = require('./db');
const crawler = require('./lib/crawler');
const { runExclusive } = require('./lib/session');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  throw new Error('.env 파일에 ADMIN_PASSWORD를 설정해주세요.');
}

const app = express();

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pass = ''] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    const a = Buffer.from(pass);
    const b = Buffer.from(ADMIN_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="streamer-tracker"');
  res.status(401).send('인증이 필요합니다.');
}

app.use(requireAuth);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/streamers', (req, res) => {
  res.json(db.prepare('SELECT * FROM streamers ORDER BY name').all());
});

app.get('/api/overview', (req, res) => {
  const yearMonth = req.query.yearMonth || crawler.lastMonthYearMonth();
  const rows = db
    .prepare(
      `SELECT s.id as streamer_id, s.name, s.status, s.platform,
              r.year_month, r.broadcast_hours, r.avg_viewers, r.max_viewers, r.collected_at
       FROM streamers s
       LEFT JOIN monthly_records r ON r.streamer_id = s.id AND r.year_month = ?
       ORDER BY s.name`
    )
    .all(yearMonth);
  res.json({ yearMonth, rows });
});

app.post('/api/streamers/search', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = await runExclusive((page) => crawler.searchChannel(page, name));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/streamers', (req, res) => {
  const { name, platform, channelId, href, status, memo } = req.body;
  if (!name || !href) return res.status(400).json({ error: 'name, href required' });
  const info = db
    .prepare(
      'INSERT INTO streamers (name, platform, channel_id, channel_href, status, memo) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(name, platform || null, channelId || null, href, status || '크리에이터', memo || '');
  res.json(db.prepare('SELECT * FROM streamers WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/streamers/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM streamers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { name, status, memo } = req.body;
  db.prepare('UPDATE streamers SET name = ?, status = ?, memo = ? WHERE id = ?').run(
    name ?? existing.name,
    status ?? existing.status,
    memo ?? existing.memo,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM streamers WHERE id = ?').get(req.params.id));
});

app.delete('/api/streamers/:id', (req, res) => {
  db.prepare('DELETE FROM streamers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/streamers/:id/records', (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM monthly_records WHERE streamer_id = ? ORDER BY year_month DESC')
      .all(req.params.id)
  );
});

function upsertRecord(streamerId, yearMonth, stats) {
  db.prepare(
    `INSERT INTO monthly_records (streamer_id, year_month, broadcast_hours, avg_viewers, max_viewers)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(streamer_id, year_month) DO UPDATE SET
       broadcast_hours = excluded.broadcast_hours,
       avg_viewers = excluded.avg_viewers,
       max_viewers = excluded.max_viewers,
       collected_at = datetime('now')`
  ).run(streamerId, yearMonth, stats.broadcastHours, stats.avgViewers, stats.maxViewers);
}

app.post('/api/streamers/:id/collect', async (req, res) => {
  const streamer = db.prepare('SELECT * FROM streamers WHERE id = ?').get(req.params.id);
  if (!streamer) return res.status(404).json({ error: 'not found' });
  const dateParam = req.body.dateParam || 'lastmonth';
  try {
    const stats = await runExclusive((page) =>
      crawler.fetchMonthlyStats(page, streamer.channel_href, dateParam)
    );
    const yearMonth = req.body.yearMonth || crawler.lastMonthYearMonth();
    upsertRecord(streamer.id, yearMonth, stats);
    res.json({ yearMonth, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/collect-all', async (req, res) => {
  const streamers = db.prepare('SELECT * FROM streamers').all();
  const results = [];
  for (const s of streamers) {
    try {
      const stats = await runExclusive((page) =>
        crawler.fetchMonthlyStats(page, s.channel_href, 'lastmonth')
      );
      const yearMonth = crawler.lastMonthYearMonth();
      upsertRecord(s.id, yearMonth, stats);
      results.push({ streamerId: s.id, name: s.name, ok: true, yearMonth, ...stats });
    } catch (err) {
      results.push({ streamerId: s.id, name: s.name, ok: false, error: err.message });
    }
  }
  res.json(results);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
