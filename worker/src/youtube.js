const API_BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(apiKey, endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: apiKey });
  const res = await fetch(`${API_BASE}/${endpoint}?${qs.toString()}`);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `YouTube API 오류 (status ${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// 채널/영상 링크 여러 형태를 다 받아본다: @handle, /channel/UC.., /c/이름(구형), /user/이름(구형),
// 영상 링크(watch?v=.. / youtu.be/..), 또는 맨 핸들 문자열만 입력한 경우.
function parseYoutubeHref(href) {
  const trimmed = (href || '').trim();
  if (!trimmed) return null;
  if (/^@[\w.-]+$/.test(trimmed)) return { type: 'handle', value: trimmed };

  let u;
  try {
    u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (u.hostname === 'youtu.be') {
    const id = u.pathname.slice(1);
    if (id) return { type: 'video', value: id };
  }

  const parts = u.pathname.split('/').filter(Boolean);
  if (u.searchParams.get('v')) return { type: 'video', value: u.searchParams.get('v') };
  if (parts[0] === 'shorts' && parts[1]) return { type: 'video', value: parts[1] };
  if (parts[0] === 'channel' && parts[1]) return { type: 'channelId', value: parts[1] };
  if (parts[0] === 'user' && parts[1]) return { type: 'username', value: parts[1] };
  if (parts[0] === 'c' && parts[1]) return { type: 'handle', value: `@${parts[1]}` }; // 구형 /c/ 링크는 핸들로도 대부분 통함
  if (parts[0] && parts[0].startsWith('@')) return { type: 'handle', value: parts[0] };

  return null;
}

// 채널 ID + 업로드 재생목록 ID를 한 번의 호출로 같이 얻는다(part에 id, contentDetails 둘 다 요청).
async function resolveChannel(apiKey, parsed) {
  let channelId = null;

  if (parsed.type === 'video') {
    const data = await ytGet(apiKey, 'videos', { part: 'snippet', id: parsed.value });
    channelId = data.items?.[0]?.snippet?.channelId;
    if (!channelId) throw new Error('이 영상 링크에서 채널을 찾을 수 없습니다. 링크를 확인해주세요.');
  }

  const lookupParams =
    parsed.type === 'channelId' || channelId
      ? { part: 'id,contentDetails', id: channelId || parsed.value }
      : parsed.type === 'handle'
        ? { part: 'id,contentDetails', forHandle: parsed.value }
        : { part: 'id,contentDetails', forUsername: parsed.value };

  const data = await ytGet(apiKey, 'channels', lookupParams);
  const channel = data.items?.[0];
  if (!channel) throw new Error('유튜브 채널을 찾을 수 없습니다. 링크를 확인해주세요.');
  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) throw new Error('이 채널의 업로드 목록을 찾을 수 없습니다.');

  return { channelId: channel.id, uploadsPlaylistId };
}

function monthRangeUtc(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end };
}

// 업로드 재생목록은 최신 업로드가 먼저 나오므로, 대상 월보다 더 오래된 영상이 나오면
// 페이지네이션을 멈춘다(그 이전 영상들은 볼 필요 없음).
async function fetchVideoIdsForMonth(apiKey, uploadsPlaylistId, yearMonth) {
  const { start, end } = monthRangeUtc(yearMonth);
  const ids = [];
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const data = await ytGet(apiKey, 'playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    let sawOlderThanRange = false;
    for (const item of data.items || []) {
      const publishedAt = item.contentDetails?.videoPublishedAt;
      if (!publishedAt) continue;
      const d = new Date(publishedAt);
      if (d >= start && d < end) ids.push(item.contentDetails.videoId);
      else if (d < start) sawOlderThanRange = true;
    }
    if (sawOlderThanRange || !data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return ids;
}

async function fetchViewCounts(apiKey, videoIds) {
  const counts = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await ytGet(apiKey, 'videos', { part: 'statistics', id: batch.join(',') });
    for (const item of data.items || []) {
      const v = Number(item.statistics?.viewCount);
      if (Number.isFinite(v)) counts.push(v);
    }
  }
  return counts;
}

// href/channelId 캐시가 있으면 그대로 쓰고, 없으면(최초 집계 또는 링크가 바뀐 경우) 새로 해석한다.
// 반환값의 channelId를 호출부에서 streamers.youtube_channel_id에 캐싱해두면 다음부터 재해석을 건너뛴다.
async function fetchMonthlyAvgViews(apiKey, youtubeHref, cachedChannelId, yearMonth) {
  let channelId = cachedChannelId;
  let uploadsPlaylistId;

  if (channelId) {
    const data = await ytGet(apiKey, 'channels', { part: 'contentDetails', id: channelId });
    uploadsPlaylistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  }
  if (!uploadsPlaylistId) {
    const parsed = parseYoutubeHref(youtubeHref);
    if (!parsed) throw new Error('유튜브 링크 형식을 인식할 수 없습니다. 채널 링크(또는 @핸들, 영상 링크)를 확인해주세요.');
    const resolved = await resolveChannel(apiKey, parsed);
    channelId = resolved.channelId;
    uploadsPlaylistId = resolved.uploadsPlaylistId;
  }

  const videoIds = await fetchVideoIdsForMonth(apiKey, uploadsPlaylistId, yearMonth);
  if (videoIds.length === 0) {
    return { channelId, videoCount: 0, avgViews: null };
  }
  const viewCounts = await fetchViewCounts(apiKey, videoIds);
  const avgViews = viewCounts.length ? Math.round(viewCounts.reduce((a, b) => a + b, 0) / viewCounts.length) : null;
  return { channelId, videoCount: videoIds.length, avgViews };
}

export { parseYoutubeHref, resolveChannel, fetchMonthlyAvgViews };
