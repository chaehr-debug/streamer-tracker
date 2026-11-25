let streamers = [];
let selectedId = null;
let searchResult = null;
let chosenCandidateIdx = 0;
let currentPlatform = 'naverchzzk';
let currentRegion = 'NA/EU';
let twitchBulkMode = false;
let youtubeBulkMode = false;
let chzzkBulkResults = [];
let manageMode = false;
let checkedStreamerIds = new Set();

function toast(msg, ms = 4000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.style.display = 'none'), ms);
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

// ---- 집계 PC(에이전트) ----
// 치지직/트위치 집계는 서버가 아니라, 에이전트가 설치돼 켜져 있는 PC 중 한 대가 처리한다.
const AGENT_GUIDE_URL = 'https://github.com/chaehr-debug/streamer-tracker/tree/main/agent#readme';
const NO_AGENT_MESSAGE =
  '지금 켜져 있는 집계 PC가 없어 요청을 취소했습니다. 상단의 "집계 PC" 안내를 참고해 본인 PC에 에이전트를 설치하거나, 설치된 PC를 켠 뒤 다시 시도해주세요.';
let agentState = { known: false, agents: [] };

async function refreshAgentStatus() {
  try {
    agentState = await api('/api/agents');
  } catch (e) {
    agentState = { known: false, agents: [] };
  }
  const el = document.getElementById('agentStatus');
  const label = el.querySelector('.label');
  el.classList.remove('online', 'offline');
  if (!agentState.known) {
    label.textContent = '집계 PC 상태 알 수 없음';
  } else if (agentState.agents.length === 0) {
    el.classList.add('offline');
    label.textContent = '켜진 집계 PC 없음';
  } else {
    el.classList.add('online');
    const busy = agentState.agents.filter((a) => a.current_job_id).length;
    label.textContent = `집계 PC ${agentState.agents.length}대 연결됨${busy ? ` (작업 중 ${busy})` : ''}`;
  }
  el.title = agentState.agents.map((a) => `${a.name}${a.current_job_id ? ' — 작업 중' : ''}`).join('\n') || '연결된 집계 PC 없음';
  if (document.getElementById('agentHelp').style.display !== 'none') renderAgentHelp();
}

function renderAgentHelp() {
  const box = document.getElementById('agentHelp');
  const list = agentState.agents.length
    ? `<ul>${agentState.agents
        .map((a) => `<li>${escapeHtml(a.name)}${a.current_job_id ? ' — 작업 #' + a.current_job_id + ' 처리 중' : ' — 대기 중'}</li>`)
        .join('')}</ul>`
    : '<p>지금 연결된 집계 PC가 없습니다. 이 상태에서는 치지직/트위치 집계·검색이 실행되지 않습니다 (유튜브 집계는 PC 없이 동작).</p>';
  box.innerHTML = `
    <strong>집계 PC</strong> — 치지직/트위치 데이터는 에이전트가 설치돼 켜져 있는 PC 중 한 대가 가져옵니다.
    ${list}
    <div>본인 PC에서도 집계를 처리하게 하려면: <a href="${AGENT_GUIDE_URL}" target="_blank" rel="noopener">에이전트 설치 안내</a>
    (설치 파일 실행 → 관리자에게 받은 접속 키 입력, 약 3분)</div>`;
}

document.getElementById('agentStatus').addEventListener('click', () => {
  const box = document.getElementById('agentHelp');
  const open = box.style.display === 'none';
  box.style.display = open ? 'block' : 'none';
  if (open) renderAgentHelp();
});
refreshAgentStatus();
setInterval(refreshAgentStatus, 20000);

async function cancelJob(jobId) {
  await api(`/api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
}

// 집계 PC가 작업을 가져가서 처리할 때까지 폴링합니다.
// - 켜진 집계 PC가 없으면 몇 초 안에 작업을 취소하고 알려준다(예전엔 90초 기다린 뒤 실패하고,
//   작업은 남아 있다가 며칠 뒤 PC가 켜지면 뒤늦게 실행됐다).
// - PC가 켜져 있으면 앞 작업(전체 집계 등)이 끝날 때까지 기다린다.
// - timeoutMs는 PC가 작업을 시작한 뒤 기다리는 최대 시간이다.
async function pollJob(jobId, { intervalMs = 2000, timeoutMs = 90000 } = {}) {
  const start = Date.now();
  let noAgentSince = null;
  let runningSince = null;
  let queueToastShown = false;
  while (true) {
    const job = await api(`/api/jobs/${jobId}`);
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw new Error(job.result?.error || '작업 처리 중 오류가 발생했습니다.');

    if (job.status === 'pending') {
      if (job.agentsOnline === 0) {
        noAgentSince = noAgentSince || Date.now();
        if (Date.now() - noAgentSince > 6000) {
          await cancelJob(jobId);
          refreshAgentStatus();
          throw new Error(NO_AGENT_MESSAGE);
        }
      } else {
        noAgentSince = null;
        if (job.queueAhead > 0 && !queueToastShown) {
          queueToastShown = true;
          toast(`앞에 처리 중인 작업이 ${job.queueAhead}개 있어 순서를 기다리는 중입니다…`, 5000);
        }
      }
      // 서버가 집계 PC 상태를 모르는 경우(구버전)는 예전처럼 timeoutMs 뒤 포기한다.
      const pendingLimit = job.agentsOnline == null ? timeoutMs : 45 * 60 * 1000;
      if (Date.now() - start > pendingLimit) {
        await cancelJob(jobId);
        throw new Error('시간 초과: 집계 PC가 작업을 가져가지 않아 요청을 취소했습니다. 잠시 후 다시 시도해주세요.');
      }
    } else if (job.status === 'running') {
      runningSince = runningSince || Date.now();
      if (Date.now() - runningSince > timeoutMs + 60000) {
        throw new Error('집계 PC가 작업 중이지만 예상보다 오래 걸리고 있습니다. 잠시 후 새로고침해 결과를 확인해주세요.');
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function platformQuery() {
  const params = new URLSearchParams({ platform: currentPlatform });
  if (currentPlatform === 'twitch') params.set('region', currentRegion);
  return params.toString();
}

function collectAllLabel() {
  if (currentPlatform === 'twitch') return `Twitch [${currentRegion}] 집계 실행`;
  if (currentPlatform === 'youtube') return '유튜브 전체 집계 실행';
  return '치지직 전체 집계 실행';
}

function updateCollectAllBtnLabel() {
  const btn = document.getElementById('collectAllBtn');
  if (!btn.disabled) btn.textContent = collectAllLabel();
}

async function loadStreamers() {
  streamers = await api(`/api/streamers?${platformQuery()}`);
  renderStreamerList();
}

function renderStreamerList() {
  const el = document.getElementById('streamerList');
  if (streamers.length === 0) {
    el.innerHTML = '<div class="muted">등록된 스트리머가 없습니다.</div>';
    return;
  }
  el.innerHTML = streamers
    .map(
      (s) => `
      <div class="streamer-item ${s.id === selectedId ? 'active' : ''}" draggable="${!manageMode}" data-id="${s.id}">
        ${
          manageMode
            ? `<input type="checkbox" class="manage-check" data-id="${s.id}" ${checkedStreamerIds.has(s.id) ? 'checked' : ''} />`
            : '<span class="drag-handle">⠿</span>'
        }
        <span>${escapeHtml(s.name)}</span>
        <span class="badge">${escapeHtml(s.status)}</span>
      </div>`
    )
    .join('');

  if (manageMode) {
    el.querySelectorAll('.manage-check').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.id);
        if (cb.checked) checkedStreamerIds.add(id);
        else checkedStreamerIds.delete(id);
      });
    });
    el.querySelectorAll('.streamer-item').forEach((node) => {
      node.addEventListener('click', () => {
        const cb = node.querySelector('.manage-check');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
        renderStreamerList();
      });
    });
    return;
  }

  el.querySelectorAll('.streamer-item').forEach((node) => {
    node.addEventListener('click', () => selectStreamer(Number(node.dataset.id)));

    node.addEventListener('dragstart', (e) => {
      draggedStreamerId = Number(node.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    node.addEventListener('dragover', (e) => {
      e.preventDefault();
      node.classList.add('drag-over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('drag-over');
      const targetId = Number(node.dataset.id);
      if (draggedStreamerId === null || targetId === draggedStreamerId) return;
      const fromIdx = streamers.findIndex((s) => s.id === draggedStreamerId);
      const toIdx = streamers.findIndex((s) => s.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = streamers.splice(fromIdx, 1);
      streamers.splice(toIdx, 0, moved);
      draggedStreamerId = null;
      renderStreamerList();
      persistStreamerOrder();
    });
  });
}

document.getElementById('manageListBtn').addEventListener('click', () => {
  manageMode = !manageMode;
  checkedStreamerIds.clear();
  document.getElementById('manageListBtn').textContent = manageMode ? '완료' : '관리';
  document.getElementById('manageDeleteBar').style.display = manageMode ? 'block' : 'none';
  renderStreamerList();
});

function exitManageMode() {
  manageMode = false;
  checkedStreamerIds.clear();
  document.getElementById('manageListBtn').textContent = '관리';
  document.getElementById('manageDeleteBar').style.display = 'none';
}

document.getElementById('deleteSelectedBtn').addEventListener('click', async () => {
  if (checkedStreamerIds.size === 0) {
    toast('삭제할 스트리머를 선택해주세요.');
    return;
  }
  if (!confirm(`선택한 ${checkedStreamerIds.size}명을 삭제하시겠습니까?`)) return;
  const btn = document.getElementById('deleteSelectedBtn');
  const deletedCount = checkedStreamerIds.size;
  btn.disabled = true;
  try {
    await api('/api/streamers/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [...checkedStreamerIds] }) });
    toast(`${deletedCount}명 삭제되었습니다.`);
    if (selectedId && checkedStreamerIds.has(selectedId)) {
      selectedId = null;
      document.getElementById('detailPanel').innerHTML = '<div class="muted">왼쪽에서 스트리머를 선택하세요.</div>';
    }
    exitManageMode();
    await loadStreamers();
  } catch (err) {
    toast('삭제 실패: ' + err.message, 6000);
  } finally {
    btn.disabled = false;
  }
});

let draggedStreamerId = null;

async function persistStreamerOrder() {
  try {
    await api('/api/streamers/reorder', {
      method: 'PUT',
      body: JSON.stringify({ ids: streamers.map((s) => s.id) }),
    });
  } catch (err) {
    toast('순서 저장 실패: ' + err.message, 6000);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function selectStreamer(id) {
  selectedId = id;
  renderStreamerList();
  const s = streamers.find((x) => x.id === id);
  const records = await api(`/api/streamers/${id}/records`);
  renderDetail(s, records);
}

function renderDetail(s, records) {
  const el = document.getElementById('detailPanel');
  el.innerHTML = `
    <div class="row" style="align-items:flex-start; margin-bottom: 12px;">
      <div style="flex:2">
        <h2 style="margin:0 0 4px">${escapeHtml(s.name)}</h2>
        <div class="muted">${escapeHtml(s.platform || '')} / ${escapeHtml(s.channel_href || '')}</div>
      </div>
      <div style="flex:1; text-align:right">
        ${s.platform === 'youtube' ? '' : '<button id="collectOneBtn">지난달 집계 실행</button>'}
        <button id="collectYoutubeBtn" class="secondary" style="margin-top:6px">유튜브 지난달 집계</button>
      </div>
    </div>
    <div class="row">
      <div>
        <label class="muted">계약 상태</label>
        <select id="editStatus">
          <option value="크리에이터" ${s.status === '크리에이터' ? 'selected' : ''}>크리에이터</option>
          <option value="파트너" ${s.status === '파트너' ? 'selected' : ''}>파트너</option>
        </select>
      </div>
      ${
        s.platform === 'twitch'
          ? `<div>
        <label class="muted">지역</label>
        <select id="editRegion">
          ${['NA/EU', 'SA/ASIA', 'JP', 'TW']
            .map((r) => `<option value="${r}" ${s.region === r ? 'selected' : ''}>${r}</option>`)
            .join('')}
        </select>
      </div>`
          : ''
      }
      <div style="flex:2">
        <label class="muted">메모</label>
        <textarea id="editMemo" rows="2">${escapeHtml(s.memo || '')}</textarea>
      </div>
    </div>
    <div class="row">
      <div style="flex:2">
        <label class="muted">유튜브 링크 (선택 — 채널 링크, @핸들, 영상 링크 모두 가능)</label>
        <input id="editYoutubeHref" value="${escapeHtml(s.youtube_href || '')}" placeholder="https://www.youtube.com/@handle" />
      </div>
    </div>
    <div class="row">
      <button id="saveBtn">저장</button>
      <button id="deleteBtn" class="danger">스트리머 삭제</button>
    </div>

    <h3 style="display:flex; align-items:center; justify-content:space-between">
      월별 기록
      <button id="exportRecordsCsvBtn" class="secondary">CSV로 내보내기</button>
    </h3>
    ${s.platform === 'twitch' ? '<div class="muted" style="margin-bottom:6px">아래 지표는 Eternal Return 카테고리 방송만 집계한 값입니다(팔로워 증감 제외).</div>' : ''}
    <table>
      <thead>
        <tr><th>월</th><th>방송 시간</th><th>평균 시청자</th><th>최대 시청자</th><th>팔로워 증감</th><th>ER 방송 횟수</th><th>유튜브 영상 수</th><th>유튜브 평균 조회수</th><th>수집 시각</th></tr>
      </thead>
      <tbody>
        ${
          records.length
            ? records
                .map(
                  (r) => `<tr>
              <td>${r.year_month}</td>
              <td>${r.broadcast_hours ?? '-'} 시간</td>
              <td>${r.avg_viewers ?? '-'} 명</td>
              <td>${r.max_viewers ?? '-'} 명</td>
              <td>${r.follower_gain ?? '-'}${r.follower_gain != null ? ' 명' : ''}</td>
              <td>${r.stream_count ?? '-'}</td>
              <td>${r.yt_video_count ?? '-'}</td>
              <td>${r.yt_avg_views != null ? r.yt_avg_views.toLocaleString('ko-KR') + ' 회' : '-'}</td>
              <td class="muted">${r.collected_at}</td>
            </tr>`
                )
                .join('')
            : '<tr><td colspan="9" class="muted">아직 수집된 기록이 없습니다.</td></tr>'
        }
      </tbody>
    </table>
  `;

  document.getElementById('collectOneBtn')?.addEventListener('click', () => collectOne(s.id));
  document.getElementById('collectYoutubeBtn').addEventListener('click', () => collectYoutube(s.id));
  document.getElementById('saveBtn').addEventListener('click', () => saveStreamer(s.id));
  document.getElementById('deleteBtn').addEventListener('click', () => deleteStreamer(s.id));
  document.getElementById('exportRecordsCsvBtn').addEventListener('click', () => {
    downloadCsv(`${s.name}_월별기록.csv`, records, [
      ['year_month', '월'],
      ['broadcast_hours', '방송시간'],
      ['avg_viewers', '평균시청자'],
      ['max_viewers', '최대시청자'],
      ['follower_gain', '팔로워증감'],
      ['stream_count', 'ER방송횟수'],
      ['yt_video_count', '유튜브영상수'],
      ['yt_avg_views', '유튜브평균조회수'],
      ['collected_at', '수집시각'],
    ]);
  });
}

async function collectYoutube(id) {
  const btn = document.getElementById('collectYoutubeBtn');
  btn.disabled = true;
  btn.textContent = '집계 중...';
  try {
    const result = await api(`/api/streamers/${id}/collect-youtube`, { method: 'POST', body: JSON.stringify({}) });
    const viewsPart = result.avgViews != null ? `평균 조회수 ${result.avgViews.toLocaleString('ko-KR')}회` : '조회수 정보 없음';
    toast(`유튜브 집계 완료: ${result.yearMonth} 영상 ${result.videoCount}개 / ${viewsPart}`, 6000);
    selectStreamer(id);
  } catch (err) {
    toast('유튜브 집계 실패: ' + err.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = '유튜브 지난달 집계';
  }
}

function downloadCsv(filename, rows, columns) {
  const header = columns.map(([, label]) => csvCell(label)).join(',');
  const body = rows
    .map((row) => columns.map(([key]) => csvCell(row[key])).join(','))
    .join('\r\n');
  const csv = header + '\r\n' + body;
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function collectOne(id) {
  const btn = document.getElementById('collectOneBtn');
  btn.disabled = true;
  btn.textContent = '집계 요청 중...';
  try {
    const { jobId } = await api(`/api/streamers/${id}/collect`, { method: 'POST', body: JSON.stringify({}) });
    btn.textContent = 'PC에서 처리 중... (최대 1분)';
    const stats = await pollJob(jobId);
    const followerPart = stats.followerGain != null ? ` / 팔로워 ${stats.followerGain > 0 ? '+' : ''}${stats.followerGain}명` : '';
    const erPart = stats.streamCount != null ? ` (ER 방송 ${stats.streamCount}회)` : '';
    toast(`집계 완료: ${stats.yearMonth} 방송 ${stats.broadcastHours}시간 / 평균 ${stats.avgViewers}명 / 최대 ${stats.maxViewers}명${followerPart}${erPart}`);
    selectStreamer(id);
  } catch (err) {
    toast('집계 실패: ' + err.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = '지난달 집계 실행';
  }
}

async function saveStreamer(id) {
  const status = document.getElementById('editStatus').value;
  const memo = document.getElementById('editMemo').value;
  const youtubeHref = document.getElementById('editYoutubeHref').value.trim();
  const regionEl = document.getElementById('editRegion');
  const body = { status, memo, youtubeHref };
  if (regionEl) body.region = regionEl.value;
  await api(`/api/streamers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  if (regionEl && regionEl.value !== currentRegion) {
    selectedId = null;
    document.getElementById('detailPanel').innerHTML = '<div class="muted">왼쪽에서 스트리머를 선택하세요.</div>';
  }
  await loadStreamers();
  toast('저장되었습니다.');
}

async function deleteStreamer(id) {
  if (!confirm('정말 삭제하시겠습니까?')) return;
  await api(`/api/streamers/${id}`, { method: 'DELETE' });
  selectedId = null;
  document.getElementById('detailPanel').innerHTML = '<div class="muted">왼쪽에서 스트리머를 선택하세요.</div>';
  await loadStreamers();
}

document.getElementById('searchBtn').addEventListener('click', async () => {
  const name = document.getElementById('searchName').value.trim();
  if (!name) return;
  const candidatesEl = document.getElementById('candidates');
  candidatesEl.innerHTML = '<div class="muted">PC에서 검색 중... (최대 1분)</div>';
  document.getElementById('addForm').style.display = 'none';
  try {
    const { jobId } = await api('/api/search-jobs', { method: 'POST', body: JSON.stringify({ name }) });
    searchResult = await pollJob(jobId);
    chosenCandidateIdx = 0;
    renderCandidates();
    document.getElementById('addForm').style.display = 'block';
  } catch (err) {
    candidatesEl.innerHTML = `<div class="muted">검색 실패: ${escapeHtml(err.message)}</div>`;
  }
});

function renderCandidates() {
  const candidatesEl = document.getElementById('candidates');
  candidatesEl.innerHTML = searchResult.allCandidates
    .map(
      (c, i) => `<div class="candidate ${i === chosenCandidateIdx ? 'selected' : ''}" data-idx="${i}">
        ${escapeHtml(c.text)}<br/><span class="muted">${escapeHtml(c.href)}</span>
      </div>`
    )
    .join('');
  candidatesEl.querySelectorAll('.candidate').forEach((node) => {
    node.addEventListener('click', () => {
      chosenCandidateIdx = Number(node.dataset.idx);
      renderCandidates();
    });
  });
}

document.getElementById('confirmAddBtn').addEventListener('click', async () => {
  const chosen = searchResult.allCandidates[chosenCandidateIdx];
  const match = chosen.href.match(/\/channel\/([^/]+)\/([^/?]+)/);
  const status = document.getElementById('addStatus').value;
  const memo = document.getElementById('addMemo').value;
  const nameInput = document.getElementById('searchName').value.trim();
  const result = await api('/api/streamers', {
    method: 'POST',
    body: JSON.stringify({
      name: nameInput,
      platform: match[1],
      channelId: match[2],
      href: chosen.href,
      status,
      memo,
    }),
  });
  document.getElementById('candidates').innerHTML = '';
  document.getElementById('addForm').style.display = 'none';
  document.getElementById('searchName').value = '';
  await loadStreamers();
  toast(result.duplicate ? '이미 등록된 채널입니다. (중복 추가되지 않았습니다)' : '스트리머가 추가되었습니다.');
});

// ---- add mode toggle (1명씩 / 여러 명 한번에) ----
document.querySelectorAll('.bulk-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const mode = btn.dataset.mode;
    document.querySelectorAll(`.bulk-mode-btn[data-target="${target}"]`).forEach((b) => b.classList.toggle('active', b === btn));
    if (target === 'chzzk') {
      document.getElementById('chzzkSingleFields').style.display = mode === 'single' ? 'block' : 'none';
      document.getElementById('chzzkBulkFields').style.display = mode === 'bulk' ? 'block' : 'none';
    } else if (target === 'twitch') {
      twitchBulkMode = mode === 'bulk';
      document.getElementById('twitchSingleFields').style.display = mode === 'single' ? 'block' : 'none';
      document.getElementById('twitchBulkFields').style.display = mode === 'bulk' ? 'block' : 'none';
      document.getElementById('twitchConfirmAddBtn').textContent = mode === 'bulk' ? '일괄 추가' : '추가';
    } else if (target === 'youtube') {
      youtubeBulkMode = mode === 'bulk';
      document.getElementById('youtubeSingleFields').style.display = mode === 'single' ? 'block' : 'none';
      document.getElementById('youtubeBulkFields').style.display = mode === 'bulk' ? 'block' : 'none';
      document.getElementById('youtubeConfirmAddBtn').textContent = mode === 'bulk' ? '일괄 추가' : '추가';
    }
  });
});

// ---- CHZZK 일괄 추가: 이름마다 검색 후, 사람이 후보를 확인/선택하고 한번에 추가 ----
function renderChzzkBulkReview() {
  const el = document.getElementById('chzzkBulkReview');
  el.innerHTML = chzzkBulkResults
    .map((r, i) => {
      if (r.status === 'pending') {
        return `<div class="bulk-row">${escapeHtml(r.name)} — <span class="muted">대기 중...</span></div>`;
      }
      if (r.status === 'error') {
        return `<div class="bulk-row muted">${escapeHtml(r.name)} — 검색 실패: ${escapeHtml(r.error)}</div>`;
      }
      return `
        <div class="bulk-row">
          <label>
            <input type="checkbox" class="bulk-include" data-idx="${i}" ${r.include === false ? '' : 'checked'} />
            <strong>${escapeHtml(r.name)}</strong>
          </label>
          <select class="bulk-candidate-select" data-idx="${i}">
            ${r.candidates
              .map((c, ci) => `<option value="${ci}" ${ci === r.chosenIdx ? 'selected' : ''}>${escapeHtml(c.text)}</option>`)
              .join('')}
          </select>
        </div>`;
    })
    .join('');

  el.querySelectorAll('.bulk-include').forEach((cb) => {
    cb.addEventListener('change', () => {
      chzzkBulkResults[Number(cb.dataset.idx)].include = cb.checked;
    });
  });
  el.querySelectorAll('.bulk-candidate-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      chzzkBulkResults[Number(sel.dataset.idx)].chosenIdx = Number(sel.value);
    });
  });
}

document.getElementById('chzzkBulkSearchBtn').addEventListener('click', async () => {
  const names = document
    .getElementById('chzzkBulkNames')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    toast('이름을 한 줄에 하나씩 입력해주세요.');
    return;
  }
  const btn = document.getElementById('chzzkBulkSearchBtn');
  btn.disabled = true;
  document.getElementById('chzzkBulkConfirmBtn').style.display = 'none';
  chzzkBulkResults = names.map((name) => ({ name, status: 'pending' }));
  renderChzzkBulkReview();

  for (let i = 0; i < names.length; i++) {
    document.getElementById('chzzkBulkProgress').textContent = `PC에서 검색 중... (${i + 1}/${names.length})`;
    try {
      const { jobId } = await api('/api/search-jobs', { method: 'POST', body: JSON.stringify({ name: names[i] }) });
      const result = await pollJob(jobId);
      chzzkBulkResults[i] = { name: names[i], status: 'ok', candidates: result.allCandidates, chosenIdx: 0 };
    } catch (err) {
      chzzkBulkResults[i] = { name: names[i], status: 'error', error: err.message };
    }
    renderChzzkBulkReview();
  }

  document.getElementById('chzzkBulkProgress').textContent = `검색 완료: 총 ${names.length}건`;
  btn.disabled = false;
  if (chzzkBulkResults.some((r) => r.status === 'ok')) {
    document.getElementById('chzzkBulkConfirmBtn').style.display = 'block';
  }
});

document.getElementById('chzzkBulkConfirmBtn').addEventListener('click', async () => {
  const status = document.getElementById('chzzkBulkStatus').value;
  const toAdd = chzzkBulkResults.filter((r) => r.status === 'ok' && r.include !== false);
  if (toAdd.length === 0) {
    toast('추가할 항목이 없습니다.');
    return;
  }
  const btn = document.getElementById('chzzkBulkConfirmBtn');
  btn.disabled = true;
  btn.textContent = '추가 중...';
  let ok = 0;
  let dup = 0;
  let fail = 0;
  for (const r of toAdd) {
    const chosen = r.candidates[r.chosenIdx];
    const match = chosen.href.match(/\/channel\/([^/]+)\/([^/?]+)/);
    try {
      const result = await api('/api/streamers', {
        method: 'POST',
        body: JSON.stringify({
          name: r.name,
          platform: match[1],
          channelId: match[2],
          href: chosen.href,
          status,
          memo: '',
        }),
      });
      if (result.duplicate) dup++;
      else ok++;
    } catch (err) {
      fail++;
    }
  }
  btn.disabled = false;
  btn.textContent = '선택한 항목 모두 추가';
  btn.style.display = 'none';
  const dupPart = dup ? ` / 중복 제외 ${dup}건` : '';
  toast(`일괄 추가 완료: 성공 ${ok}건${dupPart} / 실패 ${fail}건`, 6000);
  document.getElementById('chzzkBulkNames').value = '';
  document.getElementById('chzzkBulkProgress').textContent = '';
  chzzkBulkResults = [];
  renderChzzkBulkReview();
  await loadStreamers();
});

async function addTwitchStreamer({ name, handle, region, status, memo }) {
  return api('/api/streamers', {
    method: 'POST',
    body: JSON.stringify({
      name,
      platform: 'twitch',
      region,
      channelId: handle,
      href: `/channel/twitch/${handle}`,
      status,
      memo,
    }),
  });
}

document.getElementById('twitchConfirmAddBtn').addEventListener('click', async () => {
  const region = document.getElementById('twitchAddRegion').value;
  const status = document.getElementById('twitchAddStatus').value;
  const memo = document.getElementById('twitchAddMemo').value;
  const btn = document.getElementById('twitchConfirmAddBtn');

  if (twitchBulkMode) {
    const lines = document
      .getElementById('twitchBulkInput')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      toast('"이름,핸들" 형식으로 한 줄에 하나씩 입력해주세요.');
      return;
    }
    btn.disabled = true;
    btn.textContent = '추가 중...';
    let ok = 0;
    let dup = 0;
    const failLines = [];
    for (const line of lines) {
      const [name, handleRaw] = line.split(',').map((s) => (s || '').trim());
      const handle = (handleRaw || '').replace(/^@/, '');
      if (!name || !handle) {
        failLines.push(line);
        continue;
      }
      try {
        const result = await addTwitchStreamer({ name, handle, region, status, memo });
        if (result.duplicate) dup++;
        else ok++;
      } catch (err) {
        failLines.push(line);
      }
    }
    btn.disabled = false;
    btn.textContent = '일괄 추가';
    document.getElementById('twitchBulkInput').value = '';
    const failPart = failLines.length ? ` (실패: ${failLines.slice(0, 3).join(' / ')}${failLines.length > 3 ? ' 외' : ''})` : '';
    const dupPart = dup ? ` / 중복 제외 ${dup}건` : '';
    toast(`일괄 추가 완료: 성공 ${ok}건${dupPart} / 실패 ${failLines.length}건${failPart}`, 8000);
    await loadStreamers();
    return;
  }

  const name = document.getElementById('twitchName').value.trim();
  const handle = document.getElementById('twitchHandle').value.trim().replace(/^@/, '');
  if (!name || !handle) {
    toast('이름과 트위치 핸들을 입력해주세요.');
    return;
  }
  const result = await addTwitchStreamer({ name, handle, region, status, memo });
  document.getElementById('twitchName').value = '';
  document.getElementById('twitchHandle').value = '';
  document.getElementById('twitchAddMemo').value = '';
  await loadStreamers();
  if (result.duplicate) {
    toast('이미 등록된 채널입니다. (중복 추가되지 않았습니다)');
  } else if (region !== currentRegion) {
    toast(`스트리머가 ${region} 탭에 추가되었습니다. "지난달 집계 실행"으로 핸들이 맞는지 확인해보세요.`);
  } else {
    toast('스트리머가 추가되었습니다. "지난달 집계 실행"으로 핸들이 맞는지 확인해보세요.');
  }
});

// ---- 유튜브만 등록 (치지직/Twitch 채널 없이) ----
async function addYoutubeStreamer({ name, youtubeHref, status, memo }) {
  return api('/api/streamers', {
    method: 'POST',
    body: JSON.stringify({ name, platform: 'youtube', youtubeHref, status, memo }),
  });
}

document.getElementById('youtubeConfirmAddBtn').addEventListener('click', async () => {
  const status = document.getElementById('youtubeAddStatus').value;
  const memo = document.getElementById('youtubeAddMemo').value;
  const btn = document.getElementById('youtubeConfirmAddBtn');

  if (youtubeBulkMode) {
    const lines = document
      .getElementById('youtubeBulkInput')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      toast('"이름,유튜브 링크" 형식으로 한 줄에 하나씩 입력해주세요.');
      return;
    }
    btn.disabled = true;
    btn.textContent = '추가 중...';
    let ok = 0;
    let dup = 0;
    const failLines = [];
    for (const line of lines) {
      const [name, youtubeHref] = line.split(',').map((s) => (s || '').trim());
      if (!name || !youtubeHref) {
        failLines.push(line);
        continue;
      }
      try {
        const result = await addYoutubeStreamer({ name, youtubeHref, status, memo });
        if (result.duplicate) dup++;
        else ok++;
      } catch (err) {
        failLines.push(line);
      }
    }
    btn.disabled = false;
    btn.textContent = '일괄 추가';
    document.getElementById('youtubeBulkInput').value = '';
    const dupPart = dup ? ` / 중복 제외 ${dup}건` : '';
    const failPart = failLines.length ? ` (실패: ${failLines.slice(0, 3).join(' / ')}${failLines.length > 3 ? ' 외' : ''})` : '';
    toast(`일괄 추가 완료: 성공 ${ok}건${dupPart} / 실패 ${failLines.length}건${failPart}`, 8000);
    await loadStreamers();
    return;
  }

  const name = document.getElementById('youtubeName').value.trim();
  const youtubeHref = document.getElementById('youtubeLinkInput').value.trim();
  if (!name || !youtubeHref) {
    toast('이름과 유튜브 링크를 입력해주세요.');
    return;
  }
  const result = await addYoutubeStreamer({ name, youtubeHref, status, memo });
  document.getElementById('youtubeName').value = '';
  document.getElementById('youtubeLinkInput').value = '';
  document.getElementById('youtubeAddMemo').value = '';
  await loadStreamers();
  toast(result.duplicate ? '이미 등록된 채널입니다. (중복 추가되지 않았습니다)' : '스트리머가 추가되었습니다. "유튜브 지난달 집계"로 링크가 맞는지 확인해보세요.');
});

document.getElementById('collectAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('collectAllBtn');
  const scopeLabel = collectAllLabel();
  btn.disabled = true;

  // 유튜브는 PC 에이전트를 거치지 않고 Worker가 직접 API를 호출하므로, job 큐 없이
  // 이 화면(브라우저)에서 스트리머마다 순서대로 바로 호출한다.
  if (currentPlatform === 'youtube') {
    try {
      let ok = 0;
      let fail = 0;
      for (let i = 0; i < streamers.length; i++) {
        btn.textContent = `집계 중... (${i + 1}/${streamers.length})`;
        try {
          await api(`/api/streamers/${streamers[i].id}/collect-youtube`, { method: 'POST', body: JSON.stringify({}) });
          ok++;
        } catch (err) {
          fail++;
        }
      }
      toast(`${scopeLabel} 완료: 성공 ${ok}건 / 실패 ${fail}건`, 8000);
      if (selectedId) selectStreamer(selectedId);
      await loadStreamers();
    } catch (err) {
      toast(`${scopeLabel} 실패: ` + err.message, 8000);
    } finally {
      btn.disabled = false;
      updateCollectAllBtnLabel();
    }
    return;
  }

  btn.textContent = '집계 요청 중...';
  try {
    const body = { platform: currentPlatform };
    if (currentPlatform === 'twitch') body.region = currentRegion;
    const { jobId } = await api('/api/collect-all', { method: 'POST', body: JSON.stringify(body) });
    btn.textContent = 'PC에서 처리 중... (인원 수에 따라 최대 30분 소요)';
    const results = await pollJob(jobId, { timeoutMs: 30 * 60 * 1000 });
    const fail = results.filter((r) => !r.ok);
    toast(`${scopeLabel} 완료: 성공 ${results.length - fail.length}건 / 실패 ${fail.length}건`, 8000);
    if (selectedId) selectStreamer(selectedId);
    await loadStreamers();
  } catch (err) {
    toast(`${scopeLabel} 실패: ` + err.message, 8000);
  } finally {
    btn.disabled = false;
    updateCollectAllBtnLabel();
  }
});

// ---- platform tabs ----
document.querySelectorAll('.platform-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.platform === currentPlatform) return;
    currentPlatform = btn.dataset.platform;
    document.querySelectorAll('.platform-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    document.getElementById('chzzkAddPanel').style.display = currentPlatform === 'naverchzzk' ? 'block' : 'none';
    document.getElementById('twitchAddPanel').style.display = currentPlatform === 'twitch' ? 'block' : 'none';
    document.getElementById('youtubeAddPanel').style.display = currentPlatform === 'youtube' ? 'block' : 'none';
    document.getElementById('regionTabs').classList.toggle('visible', currentPlatform === 'twitch');
    updateCollectAllBtnLabel();
    exitManageMode();

    const screeningBtn = document.getElementById('screeningTabBtn');
    screeningBtn.style.display = currentPlatform === 'naverchzzk' ? '' : 'none';
    if (currentPlatform !== 'naverchzzk' && screeningBtn.classList.contains('active')) {
      screeningBtn.classList.remove('active');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.querySelector('.tab-btn[data-tab="manage"]').classList.add('active');
      document.getElementById('manageView').classList.add('active');
    }

    selectedId = null;
    document.getElementById('detailPanel').innerHTML = '<div class="muted">왼쪽에서 스트리머를 선택하세요.</div>';
    await loadStreamers();
    if (document.getElementById('overviewView').classList.contains('active')) {
      await loadOverview();
    }
  });
});

// ---- region tabs (Twitch 전용) ----
document.querySelectorAll('.region-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.region === currentRegion) return;
    currentRegion = btn.dataset.region;
    document.querySelectorAll('.region-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    updateCollectAllBtnLabel();
    exitManageMode();

    selectedId = null;
    document.getElementById('detailPanel').innerHTML = '<div class="muted">왼쪽에서 스트리머를 선택하세요.</div>';
    await loadStreamers();
    if (document.getElementById('overviewView').classList.contains('active')) {
      await loadOverview();
    }
  });
});

// ---- tabs ----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + 'View').classList.add('active');
    if (btn.dataset.tab === 'overview') loadOverview();
    if (btn.dataset.tab === 'screening') loadScreening();
  });
});

// ---- overview tab (전체 현황, 정렬 가능) ----
let overviewRows = [];
let overviewSortKey = 'name';
let overviewSortDir = 'asc';

async function loadOverview() {
  const data = await api(`/api/overview?${platformQuery()}`);
  document.getElementById('overviewTitle').textContent = `${data.yearMonth} 전체 현황`;
  overviewRows = data.rows;
  renderOverviewTable();
}

function compareValues(a, b) {
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'ko');
}

let overviewSortedRows = [];

function renderOverviewTable() {
  const sorted = [...overviewRows].sort((r1, r2) => {
    const cmp = compareValues(r1[overviewSortKey], r2[overviewSortKey]);
    return overviewSortDir === 'asc' ? cmp : -cmp;
  });
  overviewSortedRows = sorted;

  document.getElementById('overviewBody').innerHTML = sorted
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td><span class="badge">${escapeHtml(r.status)}</span></td>
        <td>${r.broadcast_hours ?? '-'}${r.broadcast_hours != null ? ' 시간' : ''}</td>
        <td>${r.avg_viewers ?? '-'}${r.avg_viewers != null ? ' 명' : ''}</td>
        <td>${r.max_viewers ?? '-'}${r.max_viewers != null ? ' 명' : ''}</td>
        <td>${r.follower_gain ?? '-'}${r.follower_gain != null ? ' 명' : ''}</td>
        <td>${r.platform === 'twitch' ? r.stream_count ?? '-' : '-'}</td>
        <td>${r.youtube_href ? r.yt_video_count ?? '-' : '-'}</td>
        <td>${r.youtube_href && r.yt_avg_views != null ? r.yt_avg_views.toLocaleString('ko-KR') : '-'}</td>
        <td class="muted">${r.collected_at || '집계 안 됨'}</td>
      </tr>`
    )
    .join('');

  document.querySelectorAll('#overviewTable th.sortable').forEach((th) => {
    const arrow = th.querySelector('.arrow');
    arrow.textContent = th.dataset.key === overviewSortKey ? (overviewSortDir === 'asc' ? '▲' : '▼') : '';
  });
}

document.querySelectorAll('#overviewTable th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    if (overviewSortKey === th.dataset.key) {
      overviewSortDir = overviewSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      overviewSortKey = th.dataset.key;
      overviewSortDir = 'asc';
    }
    renderOverviewTable();
  });
});

document.getElementById('exportOverviewCsvBtn').addEventListener('click', () => {
  downloadCsv('스트리머_전체현황.csv', overviewSortedRows, [
    ['name', '이름'],
    ['status', '상태'],
    ['broadcast_hours', '방송시간'],
    ['avg_viewers', '평균시청자'],
    ['max_viewers', '최대시청자'],
    ['follower_gain', '팔로워증감'],
    ['stream_count', 'ER방송횟수'],
    ['yt_video_count', '유튜브영상수'],
    ['yt_avg_views', '유튜브평균조회수'],
    ['collected_at', '수집시각'],
  ]);
});

// ---- 스트리머 심사 탭 (치지직 전용) ----
let screeningCandidates = [];
let screeningBulkResults = [];
let screeningManageMode = false;
let checkedScreeningIds = new Set();

async function loadScreening() {
  screeningCandidates = await api('/api/screening');
  renderScreeningTable();
}

function renderScreeningTable() {
  const el = document.getElementById('screeningBody');
  document.getElementById('screeningCheckboxHeader').innerHTML = screeningManageMode
    ? '<input type="checkbox" id="screeningCheckAll" />'
    : '';

  if (screeningCandidates.length === 0) {
    el.innerHTML = '<tr><td colspan="7" class="muted">심사 대상이 없습니다. 왼쪽에서 이름을 입력해 추가해주세요.</td></tr>';
    return;
  }

  el.innerHTML = screeningCandidates
    .map((c) => {
      const rowClass = c.result === 'fail' || c.result === 'error' ? 'screening-fail' : c.result === 'pending' ? 'screening-pending' : '';
      const resultLabel = { pending: '대기중', fail: '기준 미달', error: '집계 실패', pass: '통과' }[c.result] || c.result;
      return `<tr class="${rowClass}">
        <td>${screeningManageMode ? `<input type="checkbox" class="screening-check" data-id="${c.id}" ${checkedScreeningIds.has(c.id) ? 'checked' : ''} />` : ''}</td>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.broadcast_hours ?? '-'}${c.broadcast_hours != null ? ' 시간' : ''}</td>
        <td>${c.avg_viewers ?? '-'}${c.avg_viewers != null ? ' 명' : ''}</td>
        <td>${c.max_viewers ?? '-'}${c.max_viewers != null ? ' 명' : ''}</td>
        <td>${resultLabel}</td>
        <td class="muted">${c.collected_at || '-'}</td>
      </tr>`;
    })
    .join('');

  if (screeningManageMode) {
    el.querySelectorAll('.screening-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.id);
        if (cb.checked) checkedScreeningIds.add(id);
        else checkedScreeningIds.delete(id);
      });
    });
    const checkAll = document.getElementById('screeningCheckAll');
    if (checkAll) {
      checkAll.addEventListener('change', () => {
        checkedScreeningIds = checkAll.checked ? new Set(screeningCandidates.map((c) => c.id)) : new Set();
        renderScreeningTable();
      });
    }
  }
}

document.getElementById('screeningManageBtn').addEventListener('click', () => {
  screeningManageMode = !screeningManageMode;
  checkedScreeningIds.clear();
  document.getElementById('screeningManageBtn').textContent = screeningManageMode ? '완료' : '관리';
  document.getElementById('screeningDeleteBar').style.display = screeningManageMode ? 'block' : 'none';
  renderScreeningTable();
});

document.getElementById('screeningDeleteSelectedBtn').addEventListener('click', async () => {
  if (checkedScreeningIds.size === 0) {
    toast('삭제할 항목을 선택해주세요.');
    return;
  }
  if (!confirm(`선택한 ${checkedScreeningIds.size}건을 심사 명단에서 삭제하시겠습니까?`)) return;
  await api('/api/screening/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [...checkedScreeningIds] }) });
  toast(`${checkedScreeningIds.size}건 삭제되었습니다.`);
  screeningManageMode = false;
  checkedScreeningIds.clear();
  document.getElementById('screeningManageBtn').textContent = '관리';
  document.getElementById('screeningDeleteBar').style.display = 'none';
  await loadScreening();
});

document.getElementById('screeningCollectAllBtn').addEventListener('click', async () => {
  if (screeningCandidates.length === 0) {
    toast('심사 명단이 비어 있습니다.');
    return;
  }
  const btn = document.getElementById('screeningCollectAllBtn');
  btn.disabled = true;
  btn.textContent = '집계 요청 중...';
  const beforeCount = screeningCandidates.length;
  try {
    const { jobId } = await api('/api/screening/collect-all', { method: 'POST' });
    btn.textContent = 'PC에서 처리 중... (인원 수에 따라 최대 30분 소요)';
    const results = await pollJob(jobId, { timeoutMs: 30 * 60 * 1000 });
    const passCount = results.filter((r) => r.ok && r.broadcastHours >= 30 && r.avgViewers >= 30).length;
    const failCount = results.filter((r) => r.ok && !(r.broadcastHours >= 30 && r.avgViewers >= 30)).length;
    const errorCount = results.filter((r) => !r.ok).length;
    toast(
      `집계 완료: 통과(자동 등록) ${passCount}건 / 기준 미달 ${failCount}건${errorCount ? ` / 실패 ${errorCount}건` : ''}`,
      8000
    );
    await loadScreening();
    await loadStreamers();
  } catch (err) {
    toast('집계 실패: ' + err.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = '지난달 활동 집계';
  }
});

function renderScreeningBulkReview() {
  const el = document.getElementById('screeningBulkReview');
  el.innerHTML = screeningBulkResults
    .map((r, i) => {
      if (r.status === 'pending') {
        return `<div class="bulk-row">${escapeHtml(r.name)} — <span class="muted">대기 중...</span></div>`;
      }
      if (r.status === 'error') {
        return `<div class="bulk-row muted">${escapeHtml(r.name)} — 검색 실패: ${escapeHtml(r.error)}</div>`;
      }
      return `
        <div class="bulk-row">
          <label>
            <input type="checkbox" class="screening-bulk-include" data-idx="${i}" ${r.include === false ? '' : 'checked'} />
            <strong>${escapeHtml(r.name)}</strong>
          </label>
          <select class="screening-bulk-candidate-select" data-idx="${i}">
            ${r.candidates
              .map((c, ci) => `<option value="${ci}" ${ci === r.chosenIdx ? 'selected' : ''}>${escapeHtml(c.text)}</option>`)
              .join('')}
          </select>
        </div>`;
    })
    .join('');

  el.querySelectorAll('.screening-bulk-include').forEach((cb) => {
    cb.addEventListener('change', () => {
      screeningBulkResults[Number(cb.dataset.idx)].include = cb.checked;
    });
  });
  el.querySelectorAll('.screening-bulk-candidate-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      screeningBulkResults[Number(sel.dataset.idx)].chosenIdx = Number(sel.value);
    });
  });
}

document.getElementById('screeningBulkSearchBtn').addEventListener('click', async () => {
  const names = document
    .getElementById('screeningBulkNames')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    toast('이름을 한 줄에 하나씩 입력해주세요.');
    return;
  }
  const btn = document.getElementById('screeningBulkSearchBtn');
  btn.disabled = true;
  document.getElementById('screeningBulkConfirmBtn').style.display = 'none';
  screeningBulkResults = names.map((name) => ({ name, status: 'pending' }));
  renderScreeningBulkReview();

  for (let i = 0; i < names.length; i++) {
    document.getElementById('screeningBulkProgress').textContent = `PC에서 검색 중... (${i + 1}/${names.length})`;
    try {
      const { jobId } = await api('/api/search-jobs', { method: 'POST', body: JSON.stringify({ name: names[i] }) });
      const result = await pollJob(jobId);
      screeningBulkResults[i] = { name: names[i], status: 'ok', candidates: result.allCandidates, chosenIdx: 0 };
    } catch (err) {
      screeningBulkResults[i] = { name: names[i], status: 'error', error: err.message };
    }
    renderScreeningBulkReview();
  }

  document.getElementById('screeningBulkProgress').textContent = `검색 완료: 총 ${names.length}건`;
  btn.disabled = false;
  if (screeningBulkResults.some((r) => r.status === 'ok')) {
    document.getElementById('screeningBulkConfirmBtn').style.display = 'block';
  }
});

document.getElementById('screeningBulkConfirmBtn').addEventListener('click', async () => {
  const toAdd = screeningBulkResults.filter((r) => r.status === 'ok' && r.include !== false);
  if (toAdd.length === 0) {
    toast('추가할 항목이 없습니다.');
    return;
  }
  const btn = document.getElementById('screeningBulkConfirmBtn');
  btn.disabled = true;
  btn.textContent = '추가 중...';
  const candidates = toAdd.map((r) => {
    const chosen = r.candidates[r.chosenIdx];
    const match = chosen.href.match(/\/channel\/([^/]+)\/([^/?]+)/);
    return { name: r.name, platform: match[1], channelId: match[2], href: chosen.href };
  });
  try {
    const result = await api('/api/screening', { method: 'POST', body: JSON.stringify({ candidates }) });
    const dupPart = result.skipped ? ` (이미 등록/심사 중이라 제외된 ${result.skipped}건 포함)` : '';
    toast(`${result.count}건 심사 명단에 추가되었습니다.${dupPart}`, 6000);
    document.getElementById('screeningBulkNames').value = '';
    screeningBulkResults = [];
    renderScreeningBulkReview();
    btn.style.display = 'none';
    await loadScreening();
  } catch (err) {
    toast('추가 실패: ' + err.message, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '심사 명단에 추가';
  }
});

document.getElementById('screeningTabBtn').style.display = currentPlatform === 'naverchzzk' ? '' : 'none';
updateCollectAllBtnLabel();
loadStreamers();
