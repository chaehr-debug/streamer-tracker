const BASE = 'http://localhost:4000';

async function main() {
  const search = await fetch(`${BASE}/api/streamers/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '네브짱' }),
  }).then((r) => r.json());
  console.log('SEARCH:', JSON.stringify(search, null, 2));

  const created = await fetch(`${BASE}/api/streamers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '네브짱',
      platform: search.platform,
      channelId: search.channelId,
      href: search.href,
      status: '크리에이터',
      memo: '테스트 등록',
    }),
  }).then((r) => r.json());
  console.log('CREATED:', created);

  const collected = await fetch(`${BASE}/api/streamers/${created.id}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then((r) => r.json());
  console.log('COLLECTED:', collected);

  const records = await fetch(`${BASE}/api/streamers/${created.id}/records`).then((r) => r.json());
  console.log('RECORDS:', records);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
