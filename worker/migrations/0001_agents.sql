-- 집계 PC(에이전트) 접속 상태. 에이전트가 작업을 가져가거나 주기적으로 ping 할 때마다 갱신된다.
-- 사이트 상단의 "집계 PC" 표시와, 켜진 PC가 없을 때 작업을 쌓아두지 않고 바로 알려주는 데 쓴다.
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  platforms TEXT,                  -- 처리하는 플랫폼 (빈 문자열 = 전부)
  current_job_id INTEGER,          -- 지금 처리 중인 job (없으면 NULL)
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
