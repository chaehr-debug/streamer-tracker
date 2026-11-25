const fs = require('fs');
const { streamers, records } = JSON.parse(fs.readFileSync('migration-data.json', 'utf8'));

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

let sql = '';
for (const s of streamers) {
  sql += `INSERT INTO streamers (id, name, platform, channel_id, channel_href, status, memo, created_at) VALUES (${s.id}, ${esc(
    s.name
  )}, ${esc(s.platform)}, ${esc(s.channel_id)}, ${esc(s.channel_href)}, ${esc(s.status)}, ${esc(s.memo)}, ${esc(
    s.created_at
  )});\n`;
}
for (const r of records) {
  sql += `INSERT INTO monthly_records (id, streamer_id, year_month, broadcast_hours, avg_viewers, max_viewers, collected_at) VALUES (${r.id}, ${r.streamer_id}, ${esc(
    r.year_month
  )}, ${esc(r.broadcast_hours)}, ${esc(r.avg_viewers)}, ${esc(r.max_viewers)}, ${esc(r.collected_at)});\n`;
}

fs.writeFileSync('migration.sql', sql);
console.log('wrote migration.sql with', streamers.length, 'streamers and', records.length, 'records');
