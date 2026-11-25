let streamers = [];
let selectedId = null;
let searchResult = null;
let chosenCandidateIdx = 0;

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

async function loadStreamers() {
  streamers = await api('/api/streamers');
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
      <div class="streamer-item ${s.id === selectedId ? 'active' : ''}" data-id="${s.id}">
        <span>${escapeHtml(s.name)}</span>
        <span class="badge">${escapeHtml(s.status)}</span>
      </div>`
    )
    .join('');
  el.querySelectorAll('.streamer-item').forEach((node) => {
    node.addEventListener('click', () => selectStreamer(Number(node.dataset.id)));
  });
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
        <button id="collectOneBtn">지난달 집계 실행</button>
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
      <div style="flex:2">
        <label class="muted">메모</label>
        <textarea id="editMemo" rows="2">${escapeHtml(s.memo || '')}</textarea>
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
    <table>
      <thead>
        <tr><th>월</th><th>방송 시간</th><th>평균 시청자</th><th>최대 시청자</th><th>수집 시각</th></tr>
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
              <td class="muted">${r.collected_at}</td>
            </tr>`
                )
                .join('')
            : '<tr><td colspan="5" class="muted">아직 수집된 기록이 없습니다.</td></tr>'
        }
      </tbody>
    </table>
  `;

  document.getElementById('collectOneBtn').addEventListener('click', () => collectOne(s.id));
  document.getElementById('saveBtn').addEventListener('click', () => saveStreamer(s.id));
  document.getElementById('deleteBtn').addEventListener('click', () => deleteStreamer(s.id));
  document.getElementById('exportRecordsCsvBtn').addEventListener('click', () => {
    downloadCsv(`${s.name}_월별기록.csv`, records, [
      ['year_month', '월'],
      ['broadcast_hours', '방송시간'],
      ['avg_viewers', '평균시청자'],
      ['max_viewers', '최대시청자'],
      ['collected_at', '수집시각'],
    ]);
  });
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
  btn.textContent = '집계 중... (30초 내)';
  try {
    const stats = await api(`/api/streamers/${id}/collect`, { method: 'POST', body: JSON.stringify({}) });
    toast(`집계 완료: ${stats.yearMonth} 방송 ${stats.broadcastHours}시간 / 평균 ${stats.avgViewers}명 / 최대 ${stats.maxViewers}명`);
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
  await api(`/api/streamers/${id}`, { method: 'PUT', body: JSON.stringify({ status, memo }) });
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
  candidatesEl.innerHTML = '<div class="muted">검색 중...</div>';
  document.getElementById('addForm').style.display = 'none';
  try {
    searchResult = await api('/api/streamers/search', { method: 'POST', body: JSON.stringify({ name }) });
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
  await api('/api/streamers', {
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
  toast('스트리머가 추가되었습니다.');
});

document.getElementById('collectAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('collectAllBtn');
  btn.disabled = true;
  btn.textContent = '전체 집계 중...';
  try {
    const results = await api('/api/collect-all', { method: 'POST', body: JSON.stringify({}) });
    const fail = results.filter((r) => !r.ok);
    toast(`전체 집계 완료: 성공 ${results.length - fail.length}건 / 실패 ${fail.length}건`, 8000);
    if (selectedId) selectStreamer(selectedId);
    await loadStreamers();
  } catch (err) {
    toast('전체 집계 실패: ' + err.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = '전체 지난달 집계 실행';
  }
});

// ---- tabs ----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + 'View').classList.add('active');
    if (btn.dataset.tab === 'overview') loadOverview();
  });
});

// ---- overview tab (전체 현황, 정렬 가능) ----
let overviewRows = [];
let overviewSortKey = 'name';
let overviewSortDir = 'asc';

async function loadOverview() {
  const data = await api('/api/overview');
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
    ['collected_at', '수집시각'],
  ]);
});

loadStreamers();
