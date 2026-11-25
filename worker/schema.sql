CREATE TABLE IF NOT EXISTS streamers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT,
  region TEXT,               -- twitch 전용: 'NA/EU' | 'SA/ASIA' | 'JP' | 'TW'
  channel_id TEXT,
  channel_href TEXT,
  status TEXT DEFAULT '크리에이터',
  memo TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  youtube_href TEXT,          -- 선택: 유튜브 채널/영상 링크. 있으면 월별 업로드 영상 평균 조회수도 집계.
  youtube_channel_id TEXT,    -- youtube_href를 최초 집계 시 채널 ID로 해석해서 캐싱(매번 재해석 안 하도록)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monthly_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  year_month TEXT NOT NULL,
  broadcast_hours REAL,
  avg_viewers INTEGER,
  max_viewers INTEGER,
  follower_gain INTEGER,
  stream_count INTEGER,        -- twitch 전용: 해당 월 Eternal Return 카테고리 방송 횟수
  yt_video_count INTEGER,      -- 유튜브: 해당 월에 게시된 영상 수
  yt_avg_views INTEGER,        -- 유튜브: 그 영상들의 (현재 기준) 평균 조회수 — 조회수는 이후로도 계속 늘어날 수 있음
  collected_at TEXT DEFAULT (datetime('now')),
  UNIQUE(streamer_id, year_month)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,               -- 'search' | 'collect' | 'collect_all' | 'screening_collect_all'
  platform TEXT,                    -- 'naverchzzk' | 'twitch' | NULL(전체) — 에이전트가 자기가 처리할 job만 골라가는 데 사용
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'done' | 'error'
  result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 치지직 전용 "스트리머 심사" 명단. 정식 스트리머로 등록되기 전, 지난달 이터널 리턴
-- 카테고리 활동만 집계해서 기준(방송시간/평균시청자) 통과 여부를 확인하는 단계.
-- 기준을 통과하면 streamers 테이블로 승격되면서 이 테이블에서는 삭제된다.
CREATE TABLE IF NOT EXISTS screening_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'naverchzzk',
  channel_id TEXT,
  channel_href TEXT NOT NULL,
  broadcast_hours REAL,
  avg_viewers INTEGER,
  max_viewers INTEGER,
  year_month TEXT,
  result TEXT DEFAULT 'pending',    -- 'pending' | 'pass' | 'fail' | 'error'
  collected_at TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  platforms TEXT,                  -- 처리하는 플랫폼 (빈 문자열 = 전부)
  current_job_id INTEGER,          -- 지금 처리 중인 job (없으면 NULL)
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
