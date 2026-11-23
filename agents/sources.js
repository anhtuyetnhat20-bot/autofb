// Công cụ đọc Reddit và YouTube qua API chính thức cho agent research.
// Chỉ bật khi .env có khóa: REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET, YOUTUBE_API_KEY.
// Chỉ đọc. Không trả tên người dùng, chỉ trả nội dung bài, câu hỏi và số liệu tương tác,
// để agent lấy chủ đề mà không thu thập dữ liệu cá nhân.

const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, YOUTUBE_API_KEY } = process.env;
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'windows:autofb-research:0.1';

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const int = (v, def, min, max) => Math.min(max, Math.max(min, Number.isInteger(v) ? v : def));
const day = sec => new Date(sec * 1000).toISOString().slice(0, 10);

// ---------- Reddit (OAuth app-only, chỉ đọc) ----------
let redditToken = null;
async function reddit(path, params) {
  if (!redditToken || redditToken.exp < Date.now() + 60e3) {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64'),
        'User-Agent': REDDIT_USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`Reddit từ chối khóa (${res.status} ${j.error || ''})`);
    redditToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  }
  const url = new URL('https://oauth.reddit.com' + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + redditToken.value, 'User-Agent': REDDIT_USER_AGENT } });
  if (res.status === 429) throw new Error('Reddit giới hạn tốc độ, thử lại sau');
  if (!res.ok) throw new Error(`Reddit lỗi ${res.status}`);
  return res.json();
}
const redditTools = [
  {
    def: { name: 'reddit_search', description: 'Tìm bài trên Reddit qua API chính thức. Trả tiêu đề, subreddit, điểm, số bình luận, ngày, link và đoạn đầu nội dung. Không có tên người đăng.',
      input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
        query: { type: 'string', description: 'Từ khóa tìm, đúng ngôn ngữ thị trường' },
        subreddit: { type: 'string', description: 'Giới hạn trong một subreddit, không có r/. Để trống để tìm toàn Reddit' },
        sort: { type: 'string', enum: ['relevance', 'top', 'new', 'comments'] },
        time: { type: 'string', enum: ['week', 'month', 'year', 'all'] },
        limit: { type: 'integer', description: '1–25, mặc định 15' } } } },
    async run(i) {
      const path = i.subreddit ? `/r/${encodeURIComponent(i.subreddit.replace(/^r\//, ''))}/search` : '/search';
      const j = await reddit(path, { q: i.query, sort: i.sort || 'relevance', t: i.time || 'month', limit: int(i.limit, 15, 1, 25), restrict_sr: i.subreddit ? 1 : undefined, type: 'link' });
      return (j.data?.children || []).map(({ data: d }) => ({ title: d.title, subreddit: d.subreddit, score: d.score, comments: d.num_comments, date: day(d.created_utc),
        url: 'https://www.reddit.com' + d.permalink, excerpt: clip(d.selftext, 300) }));
    }
  },
  {
    def: { name: 'reddit_comments', description: 'Đọc bình luận nổi bật của một bài Reddit (link lấy từ reddit_search). Trả nội dung rút gọn và điểm, không có tên người viết.',
      input_schema: { type: 'object', additionalProperties: false, required: ['url'], properties: {
        url: { type: 'string', description: 'Link bài, dạng https://www.reddit.com/r/.../comments/...' },
        limit: { type: 'integer', description: '1–30, mặc định 20' } } } },
    async run(i) {
      const m = /reddit\.com(\/r\/[^/]+\/comments\/[a-z0-9]+)/i.exec(i.url || '');
      if (!m) throw new Error('Link không phải bài Reddit');
      const j = await reddit(m[1], { sort: 'top', limit: int(i.limit, 20, 1, 30), depth: 1 });
      return (j[1]?.data?.children || []).filter(c => c.kind === 't1').map(({ data: d }) => ({ score: d.score, text: clip(d.body, 400) }));
    }
  }
];

// ---------- YouTube Data API v3 (khóa API, chỉ đọc) ----------
async function youtube(path, params) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries({ ...params, key: YOUTUBE_API_KEY })) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube lỗi ${res.status}: ${j.error?.message || ''}`.trim());
  return j;
}
const youtubeTools = [
  {
    def: { name: 'youtube_search', description: 'Tìm video YouTube qua API chính thức, xếp theo lượt xem. Trả tiêu đề, kênh, lượt xem, thích, bình luận, số người đăng ký kênh, ngày đăng, link. Video nhiều lượt xem so với số người đăng ký là dấu hiệu chủ đề tự kéo người xem.',
      input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
        query: { type: 'string', description: 'Từ khóa tìm, đúng ngôn ngữ thị trường' },
        region: { type: 'string', description: 'Mã nước hai chữ, ví dụ US' },
        days: { type: 'integer', description: 'Chỉ lấy video đăng trong bấy nhiêu ngày, mặc định 90' },
        limit: { type: 'integer', description: '1–15, mặc định 10' } } } },
    async run(i) {
      const after = new Date(Date.now() - int(i.days, 90, 1, 3650) * 864e5).toISOString();
      const s = await youtube('search', { part: 'snippet', type: 'video', order: 'viewCount', q: i.query, regionCode: i.region, publishedAfter: after, maxResults: int(i.limit, 10, 1, 15) });
      const ids = (s.items || []).map(x => x.id.videoId).filter(Boolean);
      if (!ids.length) return [];
      const v = await youtube('videos', { part: 'statistics,snippet', id: ids.join(',') });
      const chIds = [...new Set(v.items.map(x => x.snippet.channelId))];
      const c = await youtube('channels', { part: 'statistics', id: chIds.join(',') });
      const subs = Object.fromEntries((c.items || []).map(x => [x.id, +x.statistics.subscriberCount || null]));
      return v.items.map(x => ({ title: x.snippet.title, channel: x.snippet.channelTitle, views: +x.statistics.viewCount || 0, likes: +x.statistics.likeCount || 0,
        comments: +x.statistics.commentCount || 0, channelSubscribers: subs[x.snippet.channelId], date: x.snippet.publishedAt.slice(0, 10), url: 'https://www.youtube.com/watch?v=' + x.id }));
    }
  },
  {
    def: { name: 'youtube_comments', description: 'Đọc bình luận nổi bật dưới một video YouTube để tìm câu hỏi người xem. Trả nội dung rút gọn và số thích, không có tên người viết.',
      input_schema: { type: 'object', additionalProperties: false, required: ['video'], properties: {
        video: { type: 'string', description: 'Link video hoặc mã video' },
        limit: { type: 'integer', description: '1–50, mặc định 30' } } } },
    async run(i) {
      const id = (/[?&]v=([\w-]{11})/.exec(i.video) || /youtu\.be\/([\w-]{11})/.exec(i.video) || /^([\w-]{11})$/.exec(i.video || ''))?.[1];
      if (!id) throw new Error('Không nhận ra mã video');
      const j = await youtube('commentThreads', { part: 'snippet', videoId: id, order: 'relevance', textFormat: 'plainText', maxResults: int(i.limit, 30, 1, 50) });
      return (j.items || []).map(x => ({ likes: x.snippet.topLevelComment.snippet.likeCount, replies: x.snippet.totalReplyCount, text: clip(x.snippet.topLevelComment.snippet.textDisplay, 400) }));
    }
  }
];

// Công cụ đang bật, theo khóa có trong .env. Mỗi công cụ: def (gửi cho Claude) và run (chạy trên máy).
export const sourceTools = [...(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET ? redditTools : []), ...(YOUTUBE_API_KEY ? youtubeTools : [])];
export const sourceNames = [REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET ? 'Reddit API' : null, YOUTUBE_API_KEY ? 'YouTube Data API' : null].filter(Boolean);

// Kiểm tra tối thiểu đầu vào trước khi chạy (đầu vào stream sớm có thể bị cắt dở).
export function validInput(def, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Đầu vào phải là object';
  const s = def.input_schema;
  for (const k of s.required) if (input[k] == null || input[k] === '') return `Thiếu ${k}`;
  for (const [k, v] of Object.entries(input)) {
    const p = s.properties[k];
    if (!p) return `Không có tham số ${k}`;
    if (p.type === 'string' && typeof v !== 'string') return `${k} phải là chuỗi`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `${k} phải là số nguyên`;
    if (p.enum && !p.enum.includes(v)) return `${k} phải là một trong ${p.enum.join(', ')}`;
  }
  return null;
}
