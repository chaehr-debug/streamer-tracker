import { fetchMonthlyAvgViews } from './youtube.js';

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function checkBasicAuth(request, password) {
  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = atob(encoded);
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(pass, password);
}

function unauthorized() {
  return new Response('인증이 필요합니다.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="streamer-tracker"' },
  });
}

function json(data, init) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init && init.headers) },
  });
}

function lastMonthYearMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function upsertYoutubeRecord(db, streamerId, yearMonth, stats) {
  await db
    .prepare(
      `INSERT INTO monthly_records (streamer_id, year_month, yt_video_count, yt_avg_views)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(streamer_id, year_month) DO UPDATE SET
         yt_video_count = excluded.yt_video_count,
         yt_avg_views = excluded.yt_avg_views,
         collected_at = datetime('now')`
    )
    .bind(streamerId, yearMonth, stats.videoCount ?? null, stats.avgViews ?? null)
    .run();
}

// 치지직 스트리머 심사 기준: 지난달 이터널 리턴 카테고리 방송시간/평균시청자가 모두
// 이 값 이상이면 통과 — 통과 즉시 스트리머 관리 목록에 크리에이터로 승격된다.
const SCREENING_MIN_BROADCAST_HOURS = 30;
const SCREENING_MIN_AVG_VIEWERS = 30;

async function upsertRecord(db, streamerId, yearMonth, stats) {
  await db
    .prepare(
      `INSERT INTO monthly_records (streamer_id, year_month, broadcast_hours, avg_viewers, max_viewers, follower_gain, stream_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(streamer_id, year_month) DO UPDATE SET
         broadcast_hours = excluded.broadcast_hours,
         avg_viewers = excluded.avg_viewers,
         max_viewers = excluded.max_viewers,
         follower_gain = excluded.follower_gain,
         stream_count = excluded.stream_count,
         collected_at = datetime('now')`
    )
    .bind(
      streamerId,
      yearMonth,
      stats.broadcastHours ?? null,
      stats.avgViewers ?? null,
      stats.maxViewers ?? null,
      stats.followerGain ?? null,
      stats.streamCount ?? null
    )
    .run();
}

// ---- 집계 PC(에이전트) 접속 상태 ----
// 에이전트는 대기 중엔 3초마다 next-job을, 작업 중엔 15초마다 ping을 보낸다.
// 그래서 마지막 신호가 이 시간 안에 있으면 "켜져 있음"으로 본다.
const AGENT_ONLINE_SECONDS = 45;
// 가장 긴 작업(collect_all) 제한이 30분이라, 이보다 오래 running인 job은 에이전트가
// 도중에 꺼진 것으로 보고 실패 처리한다(안 그러면 영원히 '진행 중'으로 남는다).
const STALE_RUNNING_MINUTES = 40;

function agentNameFrom(request) {
  const raw = request.headers.get('x-agent-name');
  if (!raw) return '기존 에이전트';
  try {
    return decodeURIComponent(raw).slice(0, 60);
  } catch (e) {
    return raw.slice(0, 60);
  }
}

// agents 테이블은 마이그레이션(migrations/0001_agents.sql)으로 추가된다. 적용 전이어도
// 기존 집계 흐름은 그대로 돌아가야 하므로, 이 부분의 오류는 삼킨다.
async function touchAgent(db, name, platforms, currentJobId) {
  try {
    await db
      .prepare(
        `INSERT INTO agents (name, platforms, current_job_id, last_seen) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET platforms = excluded.platforms,
           current_job_id = excluded.current_job_id, last_seen = excluded.last_seen`
      )
      .bind(name, platforms || '', currentJobId ?? null)
      .run();
  } catch (e) {}
}

// 반환: 켜져 있는 에이전트 목록. 상태를 알 수 없으면(테이블 없음) null.
async function onlineAgents(db) {
  try {
    const { results } = await db
      .prepare(
        `SELECT name, platforms, current_job_id, last_seen FROM agents
         WHERE last_seen >= datetime('now', ?) ORDER BY name`
      )
      .bind(`-${AGENT_ONLINE_SECONDS} seconds`)
      .all();
    return results;
  } catch (e) {
    return null;
  }
}

function agentHandles(agent, platform) {
  if (!agent.platforms || !platform) return true;
  return agent.platforms.split(',').map((p) => p.trim()).includes(platform);
}

async function reapStaleJobs(db) {
  await db
    .prepare(
      `UPDATE jobs SET status = 'error', result = ?, updated_at = datetime('now')
       WHERE status = 'running' AND updated_at < datetime('now', ?)`
    )
    .bind(
      JSON.stringify({ error: '집계 PC가 작업 도중 응답이 끊겨 중단되었습니다. 다시 실행해주세요.' }),
      `-${STALE_RUNNING_MINUTES} minutes`
    )
    .run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    // ---- agent-facing routes (bearer auth) ----
    if (path.startsWith('/agent/')) {
      const auth = request.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.AGENT_SECRET}`) {
        return json({ error: 'unauthorized' }, { status: 401 });
      }
      const agentName = agentNameFrom(request);

      // 작업 중인 에이전트의 생존 신호 (설치 스크립트의 접속 키 확인에도 쓰인다).
      if (path === '/agent/ping') {
        const jobId = Number(url.searchParams.get('job')) || null;
        if (url.searchParams.has('platform') || jobId) {
          await touchAgent(db, agentName, url.searchParams.get('platform') || '', jobId);
          if (jobId) {
            // 오래 걸리는 작업이 "멈춘 작업"으로 오인돼 정리되지 않도록 갱신 시각을 늘려준다.
            await db
              .prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ? AND status = 'running'")
              .bind(jobId)
              .run();
          }
        }
        return json({ ok: true });
      }

      if (path === '/agent/next-job' && request.method === 'GET') {
        // 이 에이전트가 처리할 수 있는 플랫폼 목록 (예: ?platform=twitch). 안 주면 전부 처리(기존 동작).
        const platforms = (url.searchParams.get('platform') || '')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);

        await reapStaleJobs(db);

        let job;
        if (platforms.length > 0) {
          const placeholders = platforms.map(() => '?').join(',');
          job = await db
            .prepare(
              `UPDATE jobs SET status = 'running', updated_at = datetime('now')
               WHERE id = (
                 SELECT id FROM jobs
                 WHERE status = 'pending' AND (platform IN (${placeholders}) OR platform IS NULL)
                 ORDER BY id LIMIT 1
               )
               RETURNING *`
            )
            .bind(...platforms)
            .first();
        } else {
          job = await db
            .prepare(
              `UPDATE jobs SET status = 'running', updated_at = datetime('now')
               WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
               RETURNING *`
            )
            .first();
        }
        await touchAgent(db, agentName, platforms.join(','), job ? job.id : null);
        if (!job) return json({ job: null });

        const payload = JSON.parse(job.payload);
        if (job.type === 'collect') {
          const streamer = await db.prepare('SELECT * FROM streamers WHERE id = ?').bind(payload.streamerId).first();
          payload.streamer = streamer;
        } else if (job.type === 'collect_all') {
          let streamers;
          if (payload.platform && payload.region) {
            ({ results: streamers } = await db
              .prepare('SELECT * FROM streamers WHERE platform = ? AND region = ?')
              .bind(payload.platform, payload.region)
              .all());
          } else if (payload.platform) {
            ({ results: streamers } = await db
              .prepare('SELECT * FROM streamers WHERE platform = ?')
              .bind(payload.platform)
              .all());
          } else {
            ({ results: streamers } = await db.prepare('SELECT * FROM streamers').all());
          }
          payload.streamers = streamers;
        } else if (job.type === 'screening_collect_all') {
          const { results: candidates } = await db.prepare('SELECT * FROM screening_candidates').all();
          payload.candidates = candidates;
        }
        return json({ job: { ...job, payload } });
      }

      const completeMatch = path.match(/^\/agent\/jobs\/(\d+)\/complete$/);
      if (completeMatch && request.method === 'POST') {
        const jobId = Number(completeMatch[1]);
        const body = await request.json();
        const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
        if (!job) return json({ error: 'job not found' }, { status: 404 });

        if (body.status === 'done') {
          if (job.type === 'collect') {
            const payload = JSON.parse(job.payload);
            await upsertRecord(db, payload.streamerId, body.result.yearMonth, body.result);
          } else if (job.type === 'collect_all') {
            for (const r of body.result) {
              if (r.ok) await upsertRecord(db, r.streamerId, r.yearMonth, r);
            }
          } else if (job.type === 'screening_collect_all') {
            for (const r of body.result) {
              if (!r.ok) {
                await db
                  .prepare("UPDATE screening_candidates SET result = 'error', collected_at = datetime('now') WHERE id = ?")
                  .bind(r.candidateId)
                  .run();
                continue;
              }
              const passed = r.broadcastHours >= SCREENING_MIN_BROADCAST_HOURS && r.avgViewers >= SCREENING_MIN_AVG_VIEWERS;
              if (passed) {
                const cand = await db.prepare('SELECT * FROM screening_candidates WHERE id = ?').bind(r.candidateId).first();
                if (cand) {
                  // 심사 중 같은 채널이 이미 다른 경로로 정식 등록됐을 수 있어(예: 수동으로 직접 추가),
                  // 승격 직전에도 한 번 더 중복을 확인한다.
                  const alreadyStreamer = await db
                    .prepare('SELECT id FROM streamers WHERE channel_href = ?')
                    .bind(cand.channel_href)
                    .first();
                  if (!alreadyStreamer) {
                    const { max } = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max FROM streamers').first();
                    await db
                      .prepare(
                        'INSERT INTO streamers (name, platform, region, channel_id, channel_href, status, memo, sort_order) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
                      )
                      .bind(cand.name, cand.platform, cand.channel_id, cand.channel_href, '크리에이터', '', max + 1)
                      .run();
                  }
                  await db.prepare('DELETE FROM screening_candidates WHERE id = ?').bind(r.candidateId).run();
                }
              } else {
                await db
                  .prepare(
                    "UPDATE screening_candidates SET broadcast_hours = ?, avg_viewers = ?, max_viewers = ?, year_month = ?, result = 'fail', collected_at = datetime('now') WHERE id = ?"
                  )
                  .bind(r.broadcastHours, r.avgViewers, r.maxViewers, r.yearMonth, r.candidateId)
                  .run();
              }
            }
          }
        }

        await db
          .prepare("UPDATE jobs SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(body.status, JSON.stringify(body.result ?? null), jobId)
          .run();
        return json({ ok: true });
      }

      return json({ error: 'not found' }, { status: 404 });
    }

    // ---- human-facing routes (basic auth) ----
    if (!checkBasicAuth(request, env.ADMIN_PASSWORD)) {
      return unauthorized();
    }

    if (path === '/api/streamers' && request.method === 'GET') {
      const platform = url.searchParams.get('platform');
      const region = url.searchParams.get('region');
      let results;
      if (platform && region) {
        ({ results } = await db
          .prepare('SELECT * FROM streamers WHERE platform = ? AND region = ? ORDER BY sort_order ASC, id ASC')
          .bind(platform, region)
          .all());
      } else if (platform) {
        ({ results } = await db
          .prepare('SELECT * FROM streamers WHERE platform = ? ORDER BY sort_order ASC, id ASC')
          .bind(platform)
          .all());
      } else {
        ({ results } = await db.prepare('SELECT * FROM streamers ORDER BY sort_order ASC, id ASC').all());
      }
      return json(results);
    }

    if (path === '/api/streamers/reorder' && request.method === 'PUT') {
      const { ids } = await request.json();
      if (!Array.isArray(ids)) return json({ error: 'ids array required' }, { status: 400 });
      const stmts = ids.map((id, i) =>
        db.prepare('UPDATE streamers SET sort_order = ? WHERE id = ?').bind(i, id)
      );
      await db.batch(stmts);
      return json({ ok: true });
    }

    if (path === '/api/overview' && request.method === 'GET') {
      const yearMonth = url.searchParams.get('yearMonth') || lastMonthYearMonth();
      const platform = url.searchParams.get('platform');
      const region = url.searchParams.get('region');
      const baseSql = `SELECT s.id as streamer_id, s.name, s.status, s.platform, s.region, s.youtube_href,
                  r.year_month, r.broadcast_hours, r.avg_viewers, r.max_viewers, r.follower_gain, r.stream_count,
                  r.yt_video_count, r.yt_avg_views, r.collected_at
           FROM streamers s
           LEFT JOIN monthly_records r ON r.streamer_id = s.id AND r.year_month = ?`;
      let results;
      if (platform && region) {
        ({ results } = await db
          .prepare(`${baseSql} WHERE s.platform = ? AND s.region = ? ORDER BY s.sort_order ASC, s.id ASC`)
          .bind(yearMonth, platform, region)
          .all());
      } else if (platform) {
        ({ results } = await db
          .prepare(`${baseSql} WHERE s.platform = ? ORDER BY s.sort_order ASC, s.id ASC`)
          .bind(yearMonth, platform)
          .all());
      } else {
        ({ results } = await db.prepare(`${baseSql} ORDER BY s.sort_order ASC, s.id ASC`).bind(yearMonth).all());
      }
      return json({ yearMonth, rows: results });
    }

    if (path === '/api/streamers' && request.method === 'POST') {
      const { name, platform, region, channelId, href, status, memo, youtubeHref } = await request.json();
      if (!name) return json({ error: 'name required' }, { status: 400 });
      // platform='youtube'는 치지직/Twitch 채널 없이 유튜브 채널만 등록하는 경우 — 이 경우
      // channel_href 대신 유튜브 링크 자체를 고유 식별자로 쓴다(중복 체크/삭제 등 기존 로직 재사용).
      let finalHref = href;
      let finalYoutubeHref = youtubeHref || null;
      if (platform === 'youtube') {
        if (!youtubeHref) return json({ error: 'youtubeHref required for platform=youtube' }, { status: 400 });
        finalHref = youtubeHref;
        finalYoutubeHref = youtubeHref;
      } else if (!href) {
        return json({ error: 'name, href required' }, { status: 400 });
      }
      // 같은 채널(channel_href)이 이미 등록되어 있으면 중복으로 추가하지 않고 기존 항목을 그대로 반환한다 —
      // 여러 명 한번에 추가/스트리머 심사 승격 등 여러 경로에서 같은 채널이 겹쳐 들어올 수 있다.
      const existing = await db.prepare('SELECT * FROM streamers WHERE channel_href = ?').bind(finalHref).first();
      if (existing) return json({ ...existing, duplicate: true });
      const { max } = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max FROM streamers').first();
      const info = await db
        .prepare(
          'INSERT INTO streamers (name, platform, region, channel_id, channel_href, status, memo, youtube_href, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
        )
        .bind(
          name,
          platform || null,
          region || null,
          channelId || null,
          finalHref,
          status || '크리에이터',
          memo || '',
          finalYoutubeHref,
          max + 1
        )
        .first();
      return json(info);
    }

    const idMatch = path.match(/^\/api\/streamers\/(\d+)$/);
    if (idMatch && request.method === 'PUT') {
      const id = Number(idMatch[1]);
      const existing = await db.prepare('SELECT * FROM streamers WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'not found' }, { status: 404 });
      const { name, status, memo, region, youtubeHref } = await request.json();
      // 유튜브 링크가 바뀌면 캐싱해둔 채널 ID는 더 이상 맞지 않을 수 있어 같이 지운다(다음 집계 때 재해석).
      const youtubeHrefChanged = youtubeHref !== undefined && youtubeHref !== existing.youtube_href;
      const updated = await db
        .prepare(
          'UPDATE streamers SET name = ?, status = ?, memo = ?, region = ?, youtube_href = ?, youtube_channel_id = ? WHERE id = ? RETURNING *'
        )
        .bind(
          name ?? existing.name,
          status ?? existing.status,
          memo ?? existing.memo,
          region ?? existing.region,
          youtubeHref !== undefined ? youtubeHref || null : existing.youtube_href,
          youtubeHrefChanged ? null : existing.youtube_channel_id,
          id
        )
        .first();
      return json(updated);
    }

    if (idMatch && request.method === 'DELETE') {
      await db.prepare('DELETE FROM streamers WHERE id = ?').bind(Number(idMatch[1])).run();
      return json({ ok: true });
    }

    if (path === '/api/streamers/bulk-delete' && request.method === 'POST') {
      const { ids } = await request.json();
      if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'ids array required' }, { status: 400 });
      await db.batch(ids.map((id) => db.prepare('DELETE FROM streamers WHERE id = ?').bind(Number(id))));
      return json({ ok: true });
    }

    const recordsMatch = path.match(/^\/api\/streamers\/(\d+)\/records$/);
    if (recordsMatch && request.method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM monthly_records WHERE streamer_id = ? ORDER BY year_month DESC')
        .bind(Number(recordsMatch[1]))
        .all();
      return json(results);
    }

    if (path === '/api/search-jobs' && request.method === 'POST') {
      const { name } = await request.json();
      if (!name) return json({ error: 'name required' }, { status: 400 });
      // 채널 검색은 치지직(softc.one) 전용 플로우.
      const job = await db
        .prepare("INSERT INTO jobs (type, platform, payload) VALUES ('search', 'naverchzzk', ?) RETURNING *")
        .bind(JSON.stringify({ name }))
        .first();
      return json({ jobId: job.id });
    }

    const collectMatch = path.match(/^\/api\/streamers\/(\d+)\/collect$/);
    if (collectMatch && request.method === 'POST') {
      const streamerId = Number(collectMatch[1]);
      const streamer = await db.prepare('SELECT platform FROM streamers WHERE id = ?').bind(streamerId).first();
      if (!streamer) return json({ error: 'not found' }, { status: 404 });
      const body = await request.json().catch(() => ({}));
      const job = await db
        .prepare("INSERT INTO jobs (type, platform, payload) VALUES ('collect', ?, ?) RETURNING *")
        .bind(streamer.platform, JSON.stringify({ streamerId, dateParam: body.dateParam || 'lastmonth' }))
        .first();
      return json({ jobId: job.id });
    }

    // 유튜브는 공개 API로 서버(Worker)에서 바로 조회 가능해서, PC 에이전트/브라우저를 거치는
    // job 큐를 안 쓰고 즉시 처리해서 결과를 바로 돌려준다.
    const collectYoutubeMatch = path.match(/^\/api\/streamers\/(\d+)\/collect-youtube$/);
    if (collectYoutubeMatch && request.method === 'POST') {
      const streamerId = Number(collectYoutubeMatch[1]);
      const streamer = await db.prepare('SELECT * FROM streamers WHERE id = ?').bind(streamerId).first();
      if (!streamer) return json({ error: 'not found' }, { status: 404 });
      if (!streamer.youtube_href) return json({ error: '이 스트리머에 유튜브 링크가 등록되어 있지 않습니다.' }, { status: 400 });
      if (!env.YOUTUBE_API_KEY) return json({ error: 'YOUTUBE_API_KEY가 설정되어 있지 않습니다.' }, { status: 500 });

      const body = await request.json().catch(() => ({}));
      const yearMonth = body.yearMonth || lastMonthYearMonth();

      try {
        const stats = await fetchMonthlyAvgViews(env.YOUTUBE_API_KEY, streamer.youtube_href, streamer.youtube_channel_id, yearMonth);
        if (stats.channelId && stats.channelId !== streamer.youtube_channel_id) {
          await db.prepare('UPDATE streamers SET youtube_channel_id = ? WHERE id = ?').bind(stats.channelId, streamerId).run();
        }
        await upsertYoutubeRecord(db, streamerId, yearMonth, stats);
        return json({ yearMonth, videoCount: stats.videoCount, avgViews: stats.avgViews });
      } catch (err) {
        return json({ error: err.message }, { status: 502 });
      }
    }

    if (path === '/api/collect-all' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const platform = body.platform || null;
      const region = platform === 'twitch' ? body.region || null : null;
      const job = await db
        .prepare("INSERT INTO jobs (type, platform, payload) VALUES ('collect_all', ?, ?) RETURNING *")
        .bind(platform, JSON.stringify({ platform, region }))
        .first();
      return json({ jobId: job.id });
    }

    if (path === '/api/agents' && request.method === 'GET') {
      const agents = await onlineAgents(db);
      return json({ known: agents !== null, agents: agents || [] });
    }

    const jobMatch = path.match(/^\/api\/jobs\/(\d+)$/);
    if (jobMatch && request.method === 'GET') {
      const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(Number(jobMatch[1])).first();
      if (!job) return json({ error: 'not found' }, { status: 404 });
      const extra = {};
      if (job.status === 'pending') {
        // 화면에서 "켜진 집계 PC가 없다" / "앞에 n개 작업 대기 중"을 보여주기 위한 정보.
        const agents = await onlineAgents(db);
        extra.agentsOnline = agents === null ? null : agents.filter((a) => agentHandles(a, job.platform)).length;
        const { n } = await db
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'running') AND id < ?")
          .bind(job.id)
          .first();
        extra.queueAhead = n;
      }
      return json({ ...job, ...extra, result: job.result ? JSON.parse(job.result) : null });
    }

    // 아직 아무 PC도 가져가지 않은 작업만 취소할 수 있다 — 켜진 PC가 없을 때 작업이 쌓여 있다가
    // 며칠 뒤 누군가 PC를 켰을 때 뒤늦게 실행되는 것을 막는다.
    const cancelMatch = path.match(/^\/api\/jobs\/(\d+)\/cancel$/);
    if (cancelMatch && request.method === 'POST') {
      const res = await db
        .prepare(
          "UPDATE jobs SET status = 'error', result = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
        )
        .bind(JSON.stringify({ error: '취소됨' }), Number(cancelMatch[1]))
        .run();
      return json({ ok: true, cancelled: res.meta.changes > 0 });
    }

    // ---- 치지직 스트리머 심사 명단 ----
    if (path === '/api/screening' && request.method === 'GET') {
      const { results } = await db.prepare('SELECT * FROM screening_candidates ORDER BY sort_order ASC, id ASC').all();
      return json(results);
    }

    if (path === '/api/screening' && request.method === 'POST') {
      const { candidates } = await request.json();
      if (!Array.isArray(candidates) || candidates.length === 0) {
        return json({ error: 'candidates array required' }, { status: 400 });
      }
      // 이미 심사 명단에 있거나 이미 정식 스트리머로 등록된 채널은 중복 추가하지 않는다.
      const hrefs = candidates.map((c) => c.href);
      const placeholders = hrefs.map(() => '?').join(',');
      const [{ results: dupScreening }, { results: dupStreamers }] = await Promise.all([
        db.prepare(`SELECT channel_href FROM screening_candidates WHERE channel_href IN (${placeholders})`).bind(...hrefs).all(),
        db.prepare(`SELECT channel_href FROM streamers WHERE channel_href IN (${placeholders})`).bind(...hrefs).all(),
      ]);
      const existingHrefs = new Set([...dupScreening, ...dupStreamers].map((r) => r.channel_href));
      const toInsert = candidates.filter((c) => !existingHrefs.has(c.href));
      const skipped = candidates.length - toInsert.length;

      if (toInsert.length === 0) return json({ ok: true, count: 0, skipped });

      const { max } = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max FROM screening_candidates').first();
      const stmts = toInsert.map((c, i) =>
        db
          .prepare(
            'INSERT INTO screening_candidates (name, platform, channel_id, channel_href, sort_order) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(c.name, c.platform || 'naverchzzk', c.channelId || null, c.href, max + 1 + i)
      );
      await db.batch(stmts);
      return json({ ok: true, count: toInsert.length, skipped });
    }

    if (path === '/api/screening/bulk-delete' && request.method === 'POST') {
      const { ids } = await request.json();
      if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'ids array required' }, { status: 400 });
      await db.batch(ids.map((id) => db.prepare('DELETE FROM screening_candidates WHERE id = ?').bind(Number(id))));
      return json({ ok: true });
    }

    const screeningIdMatch = path.match(/^\/api\/screening\/(\d+)$/);
    if (screeningIdMatch && request.method === 'DELETE') {
      await db.prepare('DELETE FROM screening_candidates WHERE id = ?').bind(Number(screeningIdMatch[1])).run();
      return json({ ok: true });
    }

    if (path === '/api/screening/collect-all' && request.method === 'POST') {
      const job = await db
        .prepare("INSERT INTO jobs (type, platform, payload) VALUES ('screening_collect_all', 'naverchzzk', '{}') RETURNING *")
        .first();
      return json({ jobId: job.id });
    }

    return env.ASSETS.fetch(request);
  },
};
