const BASE = process.env.WORKER_URL || 'https://streamer-tracker.coach-draft-game.workers.dev';
const AUTH = 'Basic ' + Buffer.from('admin:1234').toString('base64');
const streamerId = process.argv[2] || '2';

async function main() {
  const created = await fetch(`${BASE}/api/streamers/${streamerId}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({}),
  }).then((r) => r.json());
  console.log('created job:', created);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await fetch(`${BASE}/api/jobs/${created.jobId}`, { headers: { Authorization: AUTH } }).then((r) =>
      r.json()
    );
    console.log('poll:', job.status);
    if (job.status === 'done' || job.status === 'error') {
      console.log('RESULT:', JSON.stringify(job.result, null, 2));
      return;
    }
  }
}

main();
