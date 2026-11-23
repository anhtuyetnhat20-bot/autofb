// AUTOFB server: phục vụ dashboard, lưu không gian làm việc chung của team (thành viên, agent, task, second brain),
// cho agent trên máy từng người lấy task và nộp kết quả, đăng nhập Facebook thật (OAuth) và đọc danh sách page qua Graph API.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountClaude } from './claude-hub.js';
import { spawn } from 'node:child_process';
import fss from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  FB_APP_ID, FB_APP_SECRET,
  FB_CONFIG_ID,               // tùy chọn: dùng khi app bật Facebook Login for Business
  GRAPH_VERSION = 'v23.0',
  PORT = '3000',
  BASE_URL = `http://localhost:${PORT}`,
  HOST = '127.0.0.1'
} = process.env;

// Thiếu khóa app Meta thì vẫn chạy phần không gian làm việc, chỉ tắt đăng nhập Facebook.
const FB_ENABLED = Boolean(FB_APP_ID && FB_APP_SECRET);
if (!FB_ENABLED) console.warn('Thiếu FB_APP_ID hoặc FB_APP_SECRET: tắt đăng nhập Facebook. Sao chép .env.example thành .env và điền vào để bật.');

const REDIRECT_URI = `${BASE_URL}/auth/facebook/callback`;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const SCOPES = [
  'pages_show_list',          // liệt kê page tài khoản quản trị
  'pages_read_engagement',    // đọc thông tin, số theo dõi, bài viết
  'pages_manage_posts',       // đăng bài
  'pages_manage_engagement',  // trả lời, ẩn bình luận
  'pages_read_user_content',  // đọc bình luận của người xem
  'pages_manage_metadata',    // đăng ký webhook
  'read_insights',            // số liệu page
  'business_management'       // page nằm trong Business Manager
];
const STORE = path.join(__dirname, 'data', 'store.json');
const WS_STORE = path.join(__dirname, 'data', 'workspace.json');

// ---------- Lưu trữ đơn giản trên đĩa (một người vận hành) ----------
async function load() {
  try { return JSON.parse(await fs.readFile(STORE, 'utf8')); }
  catch { return { accounts: {} }; }
}
async function save(db) {
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(db, null, 2), { mode: 0o600 });
}

// ---------- Không gian làm việc chung ----------
// Mỗi collection là một map id -> object. Ghi tuần tự qua một hàng đợi để hai yêu cầu cùng lúc không đè nhau.
const COLLS = ['members', 'agents', 'tasks', 'brain', 'pages', 'settings', 'research', 'goals'];
const ID_RE = /^[\w-]{1,80}$/;
async function loadWs() {
  try { return JSON.parse(await fs.readFile(WS_STORE, 'utf8')); }
  catch { return {}; }
}
async function saveWs(db) {
  await fs.mkdir(path.dirname(WS_STORE), { recursive: true });
  await fs.writeFile(WS_STORE, JSON.stringify(db, null, 2));
}
let wsQueue = Promise.resolve();
function withWs(fn) {
  const run = wsQueue.then(async () => {
    const db = await loadWs();
    for (const c of COLLS) db[c] ||= {};
    const out = await fn(db);
    if (out?.save !== false) await saveWs(db);
    return out;
  });
  wsQueue = run.catch(() => {});
  return run;
}

// Bản sao GLOBAL_RULES và tên công cụ (TOOLS) trong public/index.html. Sửa thì sửa cả hai.
const GLOBAL_RULES = [
  'Nội dung nguyên bản. Chỉ lấy chủ đề từ nguồn ngoài, không lấy nội dung, không đăng lại video, ảnh, bài của người khác.',
  'Không mồi tương tác (“like nếu…”, “share để nhận…”, “tag 3 người bạn”).',
  'Không tài khoản ảo, không mua like/follow/view, không nhóm đổi tương tác giữa các page.',
  'Không tự động bình luận, nhắn tin lên page, group, tài khoản người khác.',
  'Gắn nhãn AI khi hình hoặc giọng giống người thật. Nhạc, hình phải rõ nguồn.',
  'Mỗi page một giọng, một bộ mẫu hình riêng; không dùng chung một video cho nhiều page.',
  'Bình luận tiêu cực, khiếu nại, chủ đề nhạy cảm luôn chuyển người, ở mọi mức tự động.',
  'Không đăng bài, bình luận, nhắn tin bằng trình duyệt. Thao tác trên page chỉ đi qua Graph API.'
];
const TOOL_NAMES = {
  brain: 'Đọc và ghi second brain', search: 'Tìm kiếm web', trends: 'Google Trends', adlib: 'Meta Ad Library',
  chrome: 'Claude in Chrome, chỉ đọc', graph_post: 'Đăng bài qua Graph API', graph_comments: 'Đọc bình luận',
  graph_reply: 'Trả lời, ẩn bình luận', insights: 'Đọc số liệu page', tts: 'Giọng đọc (TTS)', image: 'Tạo hình AI', ffmpeg: 'Dựng video theo mẫu',
  reddit: 'Reddit API', youtube: 'YouTube Data API', tiktok_cc: 'TikTok Creative Center'
};
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
// Hồ sơ page lấy từ bước Research: thị trường, ngôn ngữ, giọng, chủ đề.
const pageProfile = p => p ? { market: p.market || null, language: p.language || null, description: p.description || '', voice: p.voice || '', topics: p.topics || [] } : null;
// Gói ngữ cảnh agent nhận được. Cùng cấu trúc với packet() trong public/index.html.
// Cơ cấu đội và Second Brain: bản sao ROLES, BRAIN_KINDS, roleOf(), lessonText() trong public/index.html.
const ROLE_LABELS = { leader: 'Leader', research: 'Research', noidung: 'Content', designer: 'Designer', editor: 'Editor', congdong: 'Community' };
const BRAIN_KIND_KEYS = ['bai-hoc', 'phan-hoi', 'kien-thuc', 'ky-nang', 'mau', 'lien-ket', 'tong-ket'];
const roleOf = a => ROLE_LABELS[a.role || a.template] ? (a.role || a.template) : null;
const brainKind = b => BRAIN_KIND_KEYS.includes(b.kind) ? b.kind : 'bai-hoc';
const lessonText = b => (b.title ? b.title + ': ' : '') + b.text;
function pagePlan(db, t) {
  if (!t.pageId) return null;
  const plan = Object.values(db.tasks).filter(x => x.kind === 'plan' && !x.weekCal && !x.superseded && x.pageId === t.pageId && x.status === 'xong').sort((x, y) => (y.doneAt || 0) - (x.doneAt || 0))[0];
  if (!plan) return null;
  const pa = db.agents[plan.agentId], out = {};
  for (const o of plan.outputs || []) out[pa?.steps[o.step]?.name || o.step] = parseJson(o.text);
  const st = out['Chiến lược nội dung']?.strategy || {}, pl = out['Content pillar']?.pillars || [];
  const brief = { summary: st.summary, mission: st.mission, narrator: st.narrator, voice: st.voice, personas: (st.personas || []).map(p => ({ name: p.name, age: p.age, situation: p.situation, pains: p.pains, words_they_use: p.words_they_use })),
    risks: st.risks, pillars: pl.map(p => ({ name: p.name, purpose: p.purpose, role: p.role, share_pct: p.share_pct, avoid: p.avoid, series: p.series })) };
  return { title: plan.title, 'Tóm tắt kế hoạch đã duyệt': JSON.stringify(brief).slice(0, 7000) };
}
// Mức ưu tiên page (settings.focus do Tuyết chọn; mặc định theo chiến lược 20/11).
const FOCUS_MAIN = /apartment dog|dog life|remember when|80s\/90s/i;
function tierOfTask(db, t) {
  const pg = db.pages[t.pageId], f = db.settings.focus?.pages || {}, keys = [t.pageId, t.channelId, t.payload?.channelId].filter(Boolean);
  for (const k of keys) if (f[k]?.tier) return f[k].tier;
  if (!pg && !t.channelId && !t.payload?.channelId) return null;
  return FOCUS_MAIN.test(pg?.name || '') ? 'chu-luc' : 'phu';
}
function contextPacket(db, a, t) {
  const lessons = Object.values(db.brain).filter(b => b.agentId === a.id);
  const role = roleOf(a);
  const leader = Object.values(db.agents).find(x => roleOf(x) === 'leader');
  const reportsTo = db.agents[a.reportsTo]?.name || (role && role !== 'leader' ? leader?.name || null : null);
  return {
    agent: {
      id: a.id, name: a.name, role: role ? ROLE_LABELS[role] : null, reportsTo, mission: a.mission, input: a.input, output: a.output, prompt: a.prompt,
      rules: lines(a.rules), globalRules: GLOBAL_RULES,
      tools: (a.tools || []).map(k => TOOL_NAMES[k] || k).concat(lines(a.customTools)),
      steps: a.steps.map(s => ({ name: s.name, review: a.mode !== 'auto' && s.review })), definitionOfDone: a.criteria || []
    },
    lessons: lessons.filter(b => b.active && ['bai-hoc', 'phan-hoi'].includes(brainKind(b))).sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 40).map(lessonText),
    brain: Object.fromEntries(['kien-thuc', 'ky-nang', 'mau', 'lien-ket', 'tong-ket'].map(k => [k, lessons.filter(b => b.active && brainKind(b) === k).sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, k === 'tong-ket' ? 8 : 30).map(b => ({ title: b.title || '', text: b.text, url: b.url || '', tags: b.tags || [] }))])),
    goals: role === 'leader' ? Object.values(db.goals || {}).map(g => ({ title: g.title, metric: g.metric, current: g.current, target: g.target, unit: g.unit, due: g.due || null, page: db.pages[g.pageId]?.name || null })) : undefined,
    task: {
      id: t.id, title: t.title, desc: t.desc, page: db.pages[t.pageId]?.name || null, pageProfile: pageProfile(db.pages[t.pageId]), from: db.agents[t.from]?.name || 'Bạn',
      step: { index: t.step, name: a.steps[t.step]?.name },
      payload: t.payload || null,
      previousOutputs: t.outputs.map(o => ({ step: a.steps[o.step]?.name, text: o.text })),
      returnNotes: lessons.filter(b => b.taskId === t.id && b.source === 'tra-lai').map(b => b.text),
      pagePlan: t.kind === 'plan' || !['noidung', 'leader'].includes(roleOf(a)) ? null : pagePlan(db, t),
      metrics: t.kind === 'metrics' ? metricsBrief(db) : undefined,
      performance: roleOf(a) === 'noidung' && t.pageId && t.kind !== 'plan' ? perfBrief(db, t.pageId) : undefined
    }
  };
}
// Cùng logic với submitResult() và advance() trong public/index.html.
// Agent tự tổng kết vào Second Brain: khóa `_brain` trong JSON kết quả { tom_tat, bai_hoc[], mau[], kien_thuc[] }.
// Dashboard bổ sung kết quả duyệt vào mục tổng kết khi task xong (syncRecaps trong public/index.html).
function selfRecap(db, t, a, output, at) {
  let d = null;
  try { d = JSON.parse(output); } catch { const i = output.indexOf('{'), j = output.lastIndexOf('}'); if (i >= 0 && j > i) { try { d = JSON.parse(output.slice(i, j + 1)); } catch {} } }
  const b = d && typeof d === 'object' && d._brain;
  if (!b || typeof b !== 'object') return;
  let n = 0;
  const add = (kind, text, title = '') => {
    text = String(text || '').trim().slice(0, 700); if (!text) return;
    const id = 'br_' + at.toString(36) + (n++) + Math.random().toString(36).slice(2, 6);
    db.brain[id] = { id, agentId: a.id, kind, title, text, source: 'tu-tong-hop', by: a.id, taskId: t.id, at, active: true };
  };
  const list = x => Array.isArray(x) ? x : x ? [x] : [];
  add('tong-ket', b.tom_tat, `${t.title}`.slice(0, 90) + (a.steps.length > 1 ? ` · ${a.steps[t.step]?.name || ''}` : ''));
  list(b.bai_hoc).slice(0, 3).forEach(x => add('bai-hoc', x));
  list(b.mau).slice(0, 2).forEach(x => add('mau', x));
  list(b.kien_thuc).slice(0, 3).forEach(x => add('kien-thuc', x));
}
// ----- Chuyển bài tự động ngay trên server (không cần mở dashboard) -----
// Content xong: Reel sang Editor, bài khác sang Designer. Designer hoặc Editor xong: sang Leader chấm.
// Leader chấm xong: đạt thì cả chuỗi “Sẵn sàng đăng”; trượt thì giao Content sửa ở bước “Bài hoàn chỉnh”, góp ý vào Second Brain.
// Cùng logic với autoForwardRun() và settleReview() trong public/index.html; task đã có `forwarded` thì dashboard bỏ qua.
const nextRole = (t, r) => r === 'noidung' ? (/reel|video/i.test(parseJson((t.outputs || []).at(-1)?.text || '')?.post_type || t.format || '') ? 'editor' : 'designer') : (r === 'designer' || r === 'editor') ? 'leader' : null;
const sid = p => p + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const i = String(text).indexOf('{'), j = String(text).lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(String(text).slice(i, j + 1)); } catch { return null; }
}
// Rút gọn kết quả trước khi chuyển cho agent sau (tiết kiệm token): bỏ SVG, bỏ phần tự tổng kết, JSON viết liền.
function compactOut(text) {
  const t = String(text || ''); let d = null;
  try { d = JSON.parse(t); } catch { const i = t.indexOf('{'), j = t.lastIndexOf('}'); if (i >= 0 && j > i) { try { d = JSON.parse(t.slice(i, j + 1)); } catch {} } }
  if (!d || typeof d !== 'object') return t.slice(0, 8000);
  const walk = v => typeof v === 'string' ? (/^\s*<svg[\s>]/i.test(v) ? `[hình SVG ${v.length} ký tự]` : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_brain').map(([k, x]) => [k, walk(x)])) : v;
  return JSON.stringify(walk(d)).slice(0, 12000);
}
function serverForward(db, t) {
  if (t.status !== 'xong' || t.superseded) return;
  if (t.forwarded) {
    const f = db.tasks[t.forwarded], lo = t.outputs.at(-1)?.at || 0;
    if (t.kind || !f || lo <= (f.createdAt || 0) + 1000) return;
    t.forwarded = null;
    for (const x of Object.values(db.tasks)) if ((x.chain || x.id) === (t.chain || t.id) && x.id !== t.id && ['moi', 'can-sua'].includes(x.status)) {
      x.status = 'xong'; x.superseded = true; x.forwarded = 'done'; x.updatedAt = Date.now(); (x.history ||= []).push({ at: Date.now(), who: t.agentId, text: 'Bỏ: bài đã được làm lại, chuyển bản mới' }); }
  }
  const a = db.agents[t.agentId]; if (!a) return;
  const at = Date.now(), tasks = Object.values(db.tasks), agents = Object.values(db.agents), root = t.chain || t.id, rootT = db.tasks[root] || t;
  const hist = (x, who, text) => { x.history.push({ at, who, text }); x.updatedAt = at; };
  const post = { pageId: t.pageId ?? rootT.pageId ?? null, channelId: t.channelId ?? rootT.channelId ?? null, format: t.format ?? rootT.format, postDate: t.postDate ?? rootT.postDate, postTime: t.postTime ?? rootT.postTime, pillar: t.pillar ?? rootT.pillar };
  { const pt = roleOf(a) === 'noidung' ? parseJson(t.outputs.at(-1)?.text || '')?.post_type : null; if (pt) post.format = /reel|video/i.test(pt) ? 'Reel' : pt; }
  if (t.kind === 'competitor') {
    const d = parseJson(t.outputs.at(-1)?.text || '') || {}; t.forwarded = 'done';
    const pid = t.pageId, pg = db.pages[pid]; if (!pid) return null;
    const arr = (x, n) => (Array.isArray(x) ? x : []).slice(0, n);
    const doc = db.settings.competitors ||= { id: 'competitors', pages: {} }; doc.pages ||= {};
    const SOC = /^https?:\/\/([\w-]+\.)*(facebook\.com|fb\.watch|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|threads\.net)\//i;
    const soc = x => x && SOC.test(String(x.url || '')), web = [...arr(d.competitors, 30), ...arr(d.viral, 30)].filter(x => x && x.url && !soc(x)).map(x => ({ name: x.name || x.title, url: x.url }));
    d.competitors = arr(d.competitors, 30).filter(soc); d.viral = arr(d.viral, 30).filter(soc); d.sources = [...arr(d.sources, 40), ...web];
    doc.pages[pid] = { at, taskId: t.id, competitors: arr(d.competitors, 20), viral: arr(d.viral, 15), patterns: arr(d.patterns, 10), gaps: arr(d.gaps, 8), avoid: arr(d.avoid, 8), lessons: d.lessons && typeof d.lessons === 'object' ? d.lessons : {}, sources: arr(d.sources, 40), notes: String(d.notes || '').slice(0, 800) };
    // Bài học mới thay bài học cũ của cùng page (tắt mục cũ, không xóa), để gói ngữ cảnh gọn.
    for (const [k, r] of Object.entries({ content: 'noidung', designer: 'designer', editor: 'editor', leader: 'leader' })) {
      const ag = agents.find(x => roleOf(x) === r), ls = arr(d.lessons?.[k], 6).map(x => typeof x === 'string' ? x : x?.text || '').filter(Boolean);
      if (!ag || !ls.length) continue;
      for (const b of Object.values(db.brain)) if (b.agentId === ag.id && b.source === 'doi-thu' && b.pageId === pid) b.active = false;
      for (const txt of ls) { const id = sid('br'); db.brain[id] = { id, agentId: ag.id, pageId: pid, kind: 'mau', title: `${pg?.name || 'Page'}: học từ đối thủ`, text: String(txt).slice(0, 600), source: 'doi-thu', by: a.id, taskId: t.id, at, active: true }; }
    }
    return null;
  }
  if (t.kind === 'metrics') {
    // Chiến lược Leader viết cho từng page: lưu để Content đọc khi viết bài; bài học ghi vào Second Brain của Content.
    const d = parseJson(t.outputs.at(-1)?.text || '') || {}; t.forwarded = 'done';
    const doc = db.settings.strategy ||= { id: 'strategy', pages: {} }; doc.pages ||= {};
    for (const p of Array.isArray(d.pages) ? d.pages : []) {
      const pg = Object.values(db.pages).find(x => x.id === p.pageId || x.name === p.page); if (!pg) continue;
      doc.pages[pg.id] = { at, taskId: t.id, status: String(p.goal_status || ''), summary: String(p.summary || '').slice(0, 800), text: String(p.content_brief || '').slice(0, 1500),
        working: (p.working || []).slice(0, 5), not_working: (p.not_working || []).slice(0, 5), actions: (p.next_actions || []).slice(0, 6) };
    }
    const C = agents.find(x => roleOf(x) === 'noidung');
    if (C) for (const l of (Array.isArray(d.lessons) ? d.lessons : []).slice(0, 8)) if (l?.text) { const id = sid('br'); db.brain[id] = { id, agentId: C.id, kind: 'bai-hoc', text: `${l.page ? '[' + l.page + '] ' : ''}${String(l.text).slice(0, 600)}`, source: 'so-lieu', by: a.id, taskId: t.id, at, active: true }; }
    return null;
  }
  if (t.kind === 'review') {
    const last = t.outputs.at(-1)?.text || '', d = parseJson(last) || {};
    t.forwarded = 'done'; t.verdict = d.pass === true ? 'dat' : d.pass === false ? 'truot' : 'khong-ro';
    t.hold = d.pass === true && d.hold === true ? String(d.hold_reason || 'Leader muốn Tuyết xem trước khi đăng').slice(0, 300) : null;
    for (const f of Array.isArray(d.feedback) ? d.feedback : []) {
      const ag = agents.find(x => roleOf(x) && roleOf(x) !== 'leader' && ROLE_LABELS[roleOf(x)].toLowerCase().startsWith(String(f.agent || '').toLowerCase().slice(0, 5)));
      if (ag && f.text) { const id = sid('br'); db.brain[id] = { id, agentId: ag.id, kind: 'phan-hoi', text: String(f.text).slice(0, 700), source: 'leader', by: a.id, taskId: t.id, at, active: true }; }
    }
    if (t.verdict === 'dat') { tasks.filter(x => (x.chain || x.id) === root).forEach(x => { x.ready = true; x.updatedAt = at; }); if (typeof hfSweep === 'function') setTimeout(() => hfSweep().catch(() => {}), 3000); if (typeof autoSweep === 'function') setTimeout(() => autoSweep().catch(() => {}), 8000); }
    else if (t.verdict === 'truot') {
      const c = agents.find(x => roleOf(x) === 'noidung');
      if (c) {
        const fi = Math.max(0, c.steps.findIndex(st => st.name === 'Bài hoàn chỉnh'));
        const reasons = (d.reasons || []).map(r => `- ${r.rule || ''}: ${r.detail || ''}${r.fix ? ' → ' + r.fix : ''}`).join('\n');
        const fails = tasks.filter(x => (x.chain || x.id) === root && x.kind === 'review' && x.verdict === 'truot').length;
        const tk = { id: sid('tk'), chain: root, parent: t.id, title: `Sửa: ${(rootT.title || t.title).replace(/^(Sửa|Chấm): /, '')}`.slice(0, 120), ...post,
          desc: `Leader chấm trượt. Sửa đúng các điểm dưới đây rồi nộp lại bài hoàn chỉnh.\n\n${reasons}\n\n## Yêu cầu gốc\n${rootT.desc || ''}`,
          from: a.id, to: t.to || 'ban', agentId: c.id, status: 'moi', step: fi, until: fi, returns: 0, outputs: [], history: [], createdAt: at, updatedAt: at,
          noReview: !!rootT.planPost && fails < 3 };
        hist(tk, a.id, fails >= 3 ? 'Leader chấm trượt lần thứ 3, giao Content sửa, lần này bạn duyệt' : 'Leader chấm trượt, giao Content sửa');
        db.tasks[tk.id] = tk; return 'noidung';
      }
    }
    return null;
  }
  if (t.kind) return;
  const nr = nextRole(t, roleOf(a)); if (!nr) return;
  const nx = agents.find(x => roleOf(x) === nr); if (!nx) return;
  // Designer, Editor làm thẳng bước cuối (gộp phác ý tưởng vào) để mỗi bài chỉ tốn một lượt chạy mỗi agent.
  const isLead = nr === 'leader', si = isLead ? nx.steps.findIndex(st => st.name === 'Chấm bài trước khi đăng') : nx.steps.length - 1;
  if (si < 0) return;
  const prev = tasks.filter(x => (x.chain || x.id) === root && x.status === 'xong' && !x.superseded).sort((x, y) => (x.outputs.length ? x.outputs[x.outputs.length - 1].at || x.createdAt : x.createdAt) - (y.outputs.length ? y.outputs[y.outputs.length - 1].at || y.createdAt : y.createdAt))
    .map(x => { const ag = db.agents[x.agentId], o = x.outputs.at(-1); return o ? `### ${ag?.name || 'Agent'} · ${ag?.steps[o.step]?.name || ''}\n${compactOut(o.text)}` : ''; }).filter(Boolean).join('\n\n');
  const base = (rootT.title || t.title).replace(/^(Chấm|Hình|Dựng|Sửa): /, '');
  const tk = { id: sid('tk'), chain: root, parent: t.id, kind: isLead ? 'review' : null, ...post, noReview: !!(rootT.planPost || t.noReview),
    title: ((isLead ? 'Chấm: ' : nr === 'designer' ? 'Hình: ' : 'Dựng: ') + base).slice(0, 120),
    desc: (isLead ? 'Chấm bài trước khi đăng, độc lập với các agent đã làm.' : `Nhận từ ${a.name}. ${nr === 'designer' ? 'Làm hình cho bài này đúng phần “visual” của bài hoàn chỉnh và bộ nhận diện của page.' : 'Dựng video cho bài này đúng kịch bản quay trong phần “visual”.'}`) +
      `\n\n## Yêu cầu gốc\n${rootT.desc || ''}\n\n## Kết quả của các agent trước\n${prev}`,
    from: a.id, to: t.to || 'ban', agentId: nx.id, status: 'moi', step: si, until: si, returns: 0, outputs: [], history: [], createdAt: at, updatedAt: at };
  hist(tk, a.id, `${a.name} xong, tự chuyển cho ${nx.name}`);
  db.tasks[tk.id] = tk; t.forwarded = tk.id;
  return nr;
}
// Lỗi hết hạn mức của gói Claude (“You've hit your 5-hour limit · resets 8:10pm”): trả về thời điểm dùng lại được (ms), không phải thì null.
function limitUntil(msg) {
  const m = String(msg || '');
  if (!/hit your .*limit|usage limit|limit reached|rate.?limit|out of (extra )?usage|resets \d/i.test(m)) return null;
  const r = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(m);
  if (!r) return Date.now() + 30 * 60e3;
  let h = +r[1] % 12; if ((r[3] || '').toLowerCase() === 'pm') h += 12; if (!r[3] && +r[1] === 12) h = 12;
  const d = new Date(); d.setHours(h, +(r[2] || 0), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime() + 60e3;
}
function applyResult(db, t, a, output, by, metrics) {
  const at = Date.now();
  const hist = text => { t.history.push({ at, who: by, text }); t.updatedAt = at; };
  const st = a.steps[t.step];
  // Task có thể chỉ chạy một đoạn bước của agent (t.until), ví dụ Leader chỉ làm bước “Kiểm duyệt tên kênh”.
  const lastStep = Number.isInteger(t.until) ? Math.min(t.until, a.steps.length - 1) : a.steps.length - 1;
  t.outputs.push({ step: t.step, by, at, text: output });
  t.progress = null;
  selfRecap(db, t, a, output, at);
  if (metrics && typeof metrics === 'object') {
    for (const m of a.metrics || []) if (m.src === 'agent' && metrics[m.name] != null) m.value = String(metrics[m.name]);
  }
  const how = a.mode === 'auto' ? 'tự duyệt (chế độ tự động)' : 'bước này không cần duyệt';
  if (a.mode !== 'auto' && st?.review && !t.noReview) {
    t.status = 'cho-duyet';
    hist(`Nộp kết quả bước “${st.name}”, chờ duyệt`);
  } else if (t.step < lastStep) {
    t.step++; t.status = 'moi';
    hist(`Qua bước “${st?.name || ''}” (${how}), sang bước “${a.steps[t.step].name}”`);
  } else {
    t.status = 'xong'; t.doneAt = at;
    hist(`Xong (${how})`);
  }
}

// ---------- Graph API ----------
async function graph(pathname, params = {}) {
  const url = new URL(GRAPH + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return getJson(url);
}
async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || `Graph API lỗi ${res.status}`);
  return json;
}
async function listPages(userToken) {
  const out = [];
  let page = await graph('/me/accounts', {
    fields: 'id,name,category,fan_count,link,tasks,access_token',
    limit: '100',
    access_token: userToken
  });
  out.push(...page.data);
  while (page.paging?.next) {
    page = await getJson(page.paging.next);
    out.push(...page.data);
  }
  return out.map(p => ({
    id: p.id, name: p.name, category: p.category, fan_count: p.fan_count,
    link: p.link, tasks: p.tasks || [], pageToken: p.access_token
  }));
}

// Chỉ trả về những gì dashboard cần, không bao giờ trả token ra trình duyệt.
const publicAccount = a => ({
  id: a.id, name: a.name, tokenExpiresAt: a.tokenExpiresAt, connected: a.connected || [],
  pages: a.pages.map(({ pageToken, ...rest }) => rest)
});

// ---------- App ----------
const app = express();
// Ảnh do agent designer tạo (moodboard…). Gửi ảnh dạng nhị phân, lưu ở data/media, phục vụ ở /media/<tên file>.
const MEDIA_DIR = path.join(__dirname, 'data', 'media');
const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
app.post('/api/media', express.raw({ type: Object.keys(MEDIA_EXT), limit: '300mb' }), async (req, res) => {
  const ext = MEDIA_EXT[req.get('content-type')?.split(';')[0]];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Cần ảnh png, jpeg, webp hoặc video mp4, webm' });
  const file = `md_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.writeFile(path.join(MEDIA_DIR, file), req.body);
  res.json({ url: '/media/' + file });
});
app.use('/media', express.static(MEDIA_DIR, { fallthrough: false, index: false }));
// Tab Claude Code: chat với Claude CLI, chạy agent, kiểm tra máy, sao lưu (claude-hub.js).
const hub = mountClaude(app, { root: __dirname, port: PORT, express });
// Luôn bật cả đội: lúc mở server và mỗi phút, agent nào chưa chạy thì bật lại (Claude CLI), kể cả khi agent bị dừng do lỗi.
// Agent bạn tự tắt bằng công tắc thì giữ tắt. Dừng khẩn hay hết hạn mức gói Claude: agent vẫn chạy nhưng tự chờ, không nhận việc.
const tomorrowLocal = () => { const d = new Date(Date.now() + 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const requeueStale = () => withWs(db => {
  const now = Date.now(); let n = 0;
  for (const t of Object.values(db.tasks)) if (t.status === 'dang-lam' && now - (t.progress?.at || t.updatedAt || 0) > 10 * 60e3) {
    t.status = t.returns ? 'can-sua' : 'moi'; t.progress = null; t.updatedAt = now; n++;
    t.history.push({ at: now, who: t.agentId, text: 'Trả về hàng chờ: agent không còn báo tin hơn 10 phút (server hoặc agent đã khởi động lại)' });
  }
  return n ? undefined : { save: false };
}).catch(() => {});
setTimeout(requeueStale, 2000); setInterval(requeueStale, 2 * 60e3);
const reforwardSweep = () => withWs(db => {
  const woke = [];
  for (const t of Object.values(db.tasks)) if (!t.kind && t.status === 'xong' && !t.superseded && t.forwarded && db.tasks[t.forwarded] && (t.outputs.at(-1)?.at || 0) > (db.tasks[t.forwarded].createdAt || 0) + 1000) { const r = serverForward(db, t); if (r) woke.push(r); }
  setTimeout(() => woke.forEach(r => hub?.wake(r)), 500);
  return woke.length ? undefined : { save: false };
}).catch(() => {});
setTimeout(reforwardSweep, 5000); setInterval(reforwardSweep, 2 * 60e3);
const keepTeamOn = () => ['leader', 'research', 'noidung', 'designer', 'editor', 'congdong'].forEach(r => hub?.wake(r));
setTimeout(keepTeamOn, 4000); setInterval(keepTeamOn, 60e3);
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const states = new Map(); // chống CSRF cho OAuth: state -> hạn dùng

app.get('/api/health', (req, res) => res.json({ ok: true, graphVersion: GRAPH_VERSION, workspace: true, facebook: FB_ENABLED, claudeHub: true, broll: Boolean(process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY), hf: hfAvailable(), resvg: !!RESVG, ffmpeg: FFMPEG_FOUND, muse: museOn() }));

// Prompt mẫu cho agent, mỗi file prompts/<tên>.md. Lược bỏ khối ghi chú <!-- -->.
app.get('/api/prompts/:name', async (req, res) => {
  if (!/^[a-z0-9-]{1,40}$/.test(req.params.name)) return res.status(400).json({ error: 'Tên không hợp lệ' });
  try {
    const md = await fs.readFile(path.join(__dirname, 'prompts', `${req.params.name}.md`), 'utf8');
    res.type('text/plain').send(md.replace(/<!--[\s\S]*?-->\s*/g, '').trim());
  } catch {
    res.status(404).json({ error: 'Chưa có prompt mẫu này' });
  }
});

// Lần cuối mỗi agent hỏi việc (/next). Chỉ giữ trong bộ nhớ: dashboard dùng để biết agent có đang chạy trên máy nào không.
const lastSeen = new Map();

// ---------- API không gian làm việc (dashboard) ----------
app.get('/api/ws', async (req, res) => {
  const db = await loadWs();
  res.json({ ...Object.fromEntries(COLLS.map(c => [c, Object.values(db[c] || {})])), presence: Object.fromEntries(lastSeen), now: Date.now() });
});
app.put('/api/ws/:coll/:id', async (req, res) => {
  const { coll, id } = req.params;
  const obj = req.body;
  if (!COLLS.includes(coll) || !ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.id !== id) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  await withWs(db => { db[coll][id] = obj; });
  res.json({ ok: true });
});
app.delete('/api/ws/:coll/:id', async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLS.includes(coll)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  await withWs(db => { delete db[coll][id]; });
  res.json({ ok: true });
});

// ---------- Giao thức cho agent chạy trên máy từng người ----------
// Lấy task tiếp theo của agent: trả gói ngữ cảnh và chuyển task sang "Đang làm".
app.get('/api/agents/:id/next', async (req, res) => {
  if (ID_RE.test(req.params.id)) lastSeen.set(req.params.id, Date.now());
  const out = await withWs(db => {
    if (db.settings.main?.paused) return { code: 423, body: { error: 'Đang dừng khẩn' }, save: false };
    const limited = db.settings.main?.limitUntil > Date.now();
    // Claude hết hạn mức: có Muse thì Muse làm thay (trừ Designer vẽ SVG), không có thì chờ.
    if (limited && (!museOn() || process.env.MUSE_TEXT === '0' || roleOf(db.agents[req.params.id] || {}) === 'designer')) return { code: 429, body: { error: 'Gói Claude đang hết hạn mức', until: db.settings.main.limitUntil }, save: false };
    const a = db.agents[req.params.id];
    if (!a) return { code: 404, body: { error: 'Không có agent này' }, save: false };
    const t = Object.values(db.tasks)
      .filter(x => x.agentId === a.id && (x.status === 'moi' || x.status === 'can-sua') && !x.blocked && tierOfTask(db, x) !== 'dung' && !(x.waitFor && db.tasks[x.waitFor] && db.tasks[x.waitFor].status !== 'xong') && !(x.postDate && x.postDate !== todayLocal() && x.postDate !== tomorrowLocal()))
      .sort((x, y) => (x.postDate || '0').localeCompare(y.postDate || '0') || x.createdAt - y.createdAt)[0];
    if (!t) return { code: 204, save: false };
    t.status = 'dang-lam'; t.updatedAt = Date.now();
    t.progress = { at: t.updatedAt, startedAt: t.updatedAt, phase: 'Đã nhận việc', text: '', searches: 0, fetches: 0 };
    t.history.push({ at: t.updatedAt, who: a.id, text: `${a.name} nhận việc, bước “${a.steps[t.step]?.name || ''}”` });
    return { code: 200, body: { ...contextPacket(db, a, t), claudeLimited: limited || undefined, pageTier: tierOfTask(db, t) || undefined } };
  });
  if (out.code === 204) return res.status(204).end();
  res.status(out.code).json(out.body);
});
// Agent báo đang làm tới đâu: { text, searches, fetches, phase }. Dashboard vẽ thanh tiến trình từ đây.
app.post('/api/tasks/:id/progress', async (req, res) => {
  const b = req.body || {};
  const out = await withWs(db => {
    const t = db.tasks[req.params.id];
    if (!t) return { code: 404, body: { error: 'Không có task này' }, save: false };
    if (t.status !== 'dang-lam') return { code: 409, body: { error: `Task đang ở trạng thái ${t.status}` }, save: false };
    if (t.agentId) lastSeen.set(t.agentId, Date.now());
    t.progress = { at: Date.now(), startedAt: t.progress?.startedAt || Date.now(), phase: String(b.phase || '').slice(0, 80), text: String(b.text || '').slice(0, 200),
      searches: Math.max(0, +b.searches || 0), fetches: Math.max(0, +b.fetches || 0) };
    return { code: 200, body: { ok: true } };
  });
  res.status(out.code).json(out.body);
});
// Agent làm lỗi: trả task về hàng chờ. Lỗi 3 lần thì khóa (blocked), chờ người bấm “Cho chạy lại” trên dashboard.
app.post('/api/tasks/:id/release', async (req, res) => {
  const reason = String(req.body?.reason || 'không rõ').slice(0, 500);
  const out = await withWs(db => {
    const t = db.tasks[req.params.id];
    if (!t) return { code: 404, body: { error: 'Không có task này' }, save: false };
    if (t.status !== 'dang-lam') return { code: 409, body: { error: `Task đang ở trạng thái ${t.status}` }, save: false };
    const a = db.agents[t.agentId];
    const lim = +req.body?.limit > Date.now() ? +req.body.limit : limitUntil(reason);
    if (lim) {
      // Hết hạn mức gói Claude: không tính là lỗi của task; mọi agent tạm không nhận việc đến khi hạn mức hồi.
      db.settings.main = { id: 'main', paused: false, ...db.settings.main }; db.settings.main.limitUntil = Math.max(db.settings.main.limitUntil || 0, lim);
      t.progress = null; t.status = t.returns ? 'can-sua' : 'moi'; t.updatedAt = Date.now(); t.lastError = reason;
      t.history.push({ at: t.updatedAt, who: a?.id || t.to, text: `Tạm dừng vì gói Claude hết hạn mức, tự làm lại sau ${new Date(lim).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` });
      return { code: 200, body: { ok: true, limit: lim } };
    }
    t.errors = (t.errors || 0) + 1; t.lastError = reason; t.blocked = t.errors >= 3; t.progress = null;
    t.status = t.returns ? 'can-sua' : 'moi'; t.updatedAt = Date.now();
    t.history.push({ at: t.updatedAt, who: a?.owner || t.to, text: `Agent lỗi lần ${t.errors}: ${reason}${t.blocked ? '. Đã khóa, chờ người xem.' : ''}` });
    return { code: 200, body: { ok: true, errors: t.errors, blocked: t.blocked } };
  });
  res.status(out.code).json(out.body);
});
// Nộp kết quả cho bước hiện tại của task.
app.post('/api/tasks/:id/result', async (req, res) => {
  const { output, metrics, by } = req.body || {};
  if (typeof output !== 'string' || !output.trim()) return res.status(400).json({ error: 'Thiếu output' });
  if (output.length > 400000) return res.status(413).json({ error: 'output quá dài (tối đa 400.000 ký tự)' });
  const out = await withWs(db => {
    if (db.settings.main?.paused) return { code: 423, body: { error: 'Đang dừng khẩn' }, save: false };
    const t = db.tasks[req.params.id];
    if (!t) return { code: 404, body: { error: 'Không có task này' }, save: false };
    const a = db.agents[t.agentId];
    if (!a) return { code: 409, body: { error: 'Task chưa gán agent' }, save: false };
    if (t.status === 'xong' || t.status === 'cho-duyet') return { code: 409, body: { error: `Task đang ở trạng thái ${t.status}, không nhận kết quả` }, save: false };
    applyResult(db, t, a, output.trim(), db.members[by] ? by : a.id, metrics);
    const wake = serverForward(db, t);
    return { code: 200, body: { ok: true, status: t.status, step: t.step }, wake };
  });
  if (out.wake) hub?.wake(out.wake);
  res.status(out.code).json(out.body);
});

// ---------- Facebook ----------
app.use(['/auth/facebook', '/api/accounts'], (req, res, next) => {
  if (FB_ENABLED) return next();
  if (req.baseUrl.startsWith('/api')) return res.status(503).json({ error: 'Chưa cấu hình FB_APP_ID, FB_APP_SECRET' });
  res.status(503).send(resultPage(false, 'Chưa bật đăng nhập Facebook', 'Điền FB_APP_ID và FB_APP_SECRET trong .env rồi chạy lại server.'));
});


// ---------- B-roll có giấy phép cho Reel ----------
// Chỉ lấy từ Pexels và Pixabay: clip được phép tải, cắt, chỉnh màu, ghép chữ và đăng thương mại miễn phí.
// Không lấy video của người khác trên mạng xã hội hay YouTube. Clip tải về lưu ở data/media/broll_<id>.mp4, dùng lại được.
const brollCache = new Map();
async function brollSearch(q) {
  if (brollCache.has(q)) return brollCache.get(q);
  const { PEXELS_API_KEY, PIXABAY_API_KEY } = process.env, list = [];
  if (PEXELS_API_KEY) {
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`, { headers: { Authorization: PEXELS_API_KEY } });
    const j = await r.json().catch(() => ({}));
    for (const v of j.videos || []) {
      const mp4 = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.width && f.height);
      const f = mp4.filter(f => f.height >= f.width && f.height >= 1000).sort((a, b) => a.height - b.height)[0] || mp4.filter(f => f.height >= 720).sort((a, b) => b.height - a.height)[0];
      if (f) list.push({ id: 'px' + v.id, link: f.link, w: f.width, h: f.height, dur: v.duration, by: v.user?.name || '', src: v.url, site: 'Pexels' });
    }
  }
  if (PIXABAY_API_KEY && list.length < 6) {
    const r = await fetch(`https://pixabay.com/api/videos/?key=${encodeURIComponent(PIXABAY_API_KEY)}&q=${encodeURIComponent(q)}&per_page=15&safesearch=true`);
    const j = await r.json().catch(() => ({}));
    for (const h of j.hits || []) { const f = h.videos?.large?.url ? h.videos.large : h.videos?.medium; if (f?.url) list.push({ id: 'pb' + h.id, link: f.url, w: f.width, h: f.height, dur: h.duration, by: h.user || '', src: h.pageURL, site: 'Pixabay' }); }
  }
  list.sort((a, b) => (b.h >= b.w) - (a.h >= a.w));
  brollCache.set(q, list);
  return list;
}
app.get('/api/broll', async (req, res) => {
  const q = String(req.query.q || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().slice(0, 80), skip = new Set(String(req.query.skip || '').split(',').filter(Boolean));
  if (!q) return res.status(400).json({ error: 'Thiếu từ khóa' });
  if (!process.env.PEXELS_API_KEY && !process.env.PIXABAY_API_KEY) return res.status(404).json({ error: 'Chưa có PEXELS_API_KEY hoặc PIXABAY_API_KEY trong .env' });
  try {
    const pool = (await brollSearch(q)).filter(x => !skip.has(x.id) && (x.dur || 10) >= 4).slice(0, 6);
    if (!pool.length) return res.status(404).json({ error: 'Không tìm thấy clip hợp với “' + q + '”' });
    const pick = pool[Math.floor(Math.random() * pool.length)], file = `broll_${pick.id}.mp4`, fp = path.join(MEDIA_DIR, file);
    try { await fs.access(fp); } catch {
      await fs.mkdir(MEDIA_DIR, { recursive: true });
      const r = await fetch(pick.link); if (!r.ok) throw new Error('Tải clip lỗi ' + r.status);
      await fs.writeFile(fp, Buffer.from(await r.arrayBuffer()));
    }
    res.json({ url: '/media/' + file, id: pick.id, by: pick.by, src: pick.src, site: pick.site });
  } catch (err) { res.status(502).json({ error: err.message }); }
});


// ---------- Đăng bài lên page qua Graph API ----------
// Bạn bấm “Duyệt & đăng” trên dashboard → server lấy bài hoàn chỉnh (caption của Content, ảnh PNG hoặc video do app dựng)
// rồi gửi lên đúng page bằng page token đã lưu khi đăng nhập Facebook. Có giờ trong lịch thì hẹn giờ, giờ đã qua thì đăng ngay.
const MEDIA_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };
const mediaFile = u => { const m = /^\/media\/([\w.-]+)$/.exec(String(u || '')); return m ? path.join(MEDIA_DIR, m[1]) : null; };
function graphErr(json, status) { const e = json?.error; return new Error(e ? (e.error_user_msg || e.message) + (e.code ? ` (mã ${e.code})` : '') : `Graph API lỗi ${status}`); }
async function graphPost(pathname, params, token) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  body.set('access_token', token);
  const res = await fetch(GRAPH + pathname, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw graphErr(json, res.status);
  return json;
}
async function graphUpload(pathname, params, token, file, base = GRAPH) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) fd.append(k, String(v));
  fd.append('access_token', token);
  const buf = await fs.readFile(file);
  fd.append('source', new Blob([buf], { type: MEDIA_MIME[path.extname(file).slice(1)] || 'application/octet-stream' }), path.basename(file));
  const res = await fetch(base + pathname, { method: 'POST', body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw graphErr(json, res.status);
  return json;
}
// Ngày + giờ ET (America/New_York, tự tính giờ mùa hè) → epoch giây.
function etEpoch(date, hhmm) {
  const [y, mo, d] = String(date || '').split('-').map(Number), [h, mi] = String(hhmm || '').split(':').map(Number);
  if (!y || !mo || !d || !Number.isFinite(h)) return null;
  const want = Date.UTC(y, mo - 1, d, h, mi || 0); let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    guess += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return Math.floor(guess / 1000);
}
// Bài của một chuỗi: bài hoàn chỉnh mới nhất của Content, task Designer/Editor mới nhất, Leader đã chấm đạt bản mới nhất chưa.
function postBundle(db, id) {
  const t0 = db.tasks[id]; if (!t0) return null;
  const root = db.tasks[t0.chain || t0.id] || t0;
  const ts = Object.values(db.tasks).filter(x => (x.chain || x.id) === root.id).sort((a, b) => a.createdAt - b.createdAt);
  let post = null;
  for (const o of ts.filter(t => !t.superseded).flatMap(t => t.outputs || []).sort((a, b) => (b.at || 0) - (a.at || 0))) { const d = parseJson(o.text); if (d?.post_type && typeof d.caption === 'string') { post = d; break; } }
  const lastBy = role => ts.filter(t => !t.superseded && t.outputs?.length && roleOf(db.agents[t.agentId] || {}) === role).sort((a, b) => (b.outputs.at(-1).at || 0) - (a.outputs.at(-1).at || 0))[0];
  const rv = ts.filter(x => x.kind === 'review' && x.status === 'xong').at(-1);
  const ready = !!rv && rv.verdict === 'dat' && !ts.some(x => x.createdAt > rv.createdAt && x.status !== 'xong' && !x.superseded);
  const reel = /reel|video/i.test(post?.post_type || '');
  const src = lastBy(reel ? 'editor' : 'designer');
  return { root, ts, post, ready, reel, key: reel ? (src ? `${src.id}:${src.outputs.length}` : 'post') : (src ? `${src.id}:${src.outputs.length}` : '') };
}
async function publishPost(id, body = {}, auto = null) {
  {
    const ws = await loadWs(); for (const c of COLLS) ws[c] ||= {};
    const b = postBundle(ws, id);
    if (!b?.post) throw httpErr(400, 'Bài chưa có bản hoàn chỉnh của Content');
    const { root, post } = b;
    if (!b.ready) throw httpErr(400, 'Bản mới nhất của bài chưa được Leader chấm đạt');
    const done = ws.settings.published?.posts?.[root.id];
    if (done && !body.again) throw httpErr(409, 'Bài này đã được gửi lên Facebook rồi');
    const fbId = ws.pages[root.pageId]?.fbId;
    if (!fbId) throw httpErr(400, 'Page trong AUTOFB chưa gắn với page Facebook nào');
    const store = await load();
    // Nhiều tài khoản cùng có page này (đăng nhập qua nhiều app): dùng token mới nhất.
    let token = Object.values(store.accounts || {}).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).flatMap(a => a.pages || []).find(p => p.id === String(fbId) && p.pageToken)?.pageToken;
    // Page chưa có trong danh sách đã lưu (page mới, hoặc lúc đăng nhập chưa quét): hỏi thẳng Facebook bằng token tài khoản.
    if (!token) for (const a of Object.values(store.accounts || {})) {
      try { const pg = await graph(`/${fbId}`, { fields: 'id,name,access_token', access_token: a.userToken });
        if (pg.access_token) { token = pg.access_token; a.pages = [...(a.pages || []).filter(p => p.id !== pg.id), { id: pg.id, name: pg.name, tasks: [], pageToken: pg.access_token }]; await save(store); break; } } catch {}
    }
    if (!token) throw httpErr(400, `Facebook chưa cấp quyền cho app với page “${ws.pages[root.pageId]?.name || fbId}”. Vào Kết nối Facebook, bấm “Đăng nhập thêm tài khoản”, đăng nhập lại; ở bước Facebook hỏi chọn Page, tích chọn page này (nên chọn tất cả page), cho phép tạo và quản lý bài viết. Xong quay lại bấm Duyệt & đăng.`);
    const media = root.media || {};
    if (b.reel && hfSpec(ws, b) && !media.hf && !media.own) throw httpErr(400, 'Video chưa dựng bằng HyperFrames (bản kiểu cũ không được đăng). Cài HyperFrames trên máy hoặc gắn video đã dựng.');
    if (b.key && media.key !== b.key && !media.own) throw httpErr(400, 'Hình hoặc video chưa dựng từ bản mới nhất. Mở “Xem bài”, đợi app dựng xong rồi đăng.');
    const files = (media.files || []).map(mediaFile).filter(Boolean);
    for (const f of files) await fs.access(f).catch(() => { throw new Error('Không còn file ' + path.basename(f) + ' trên máy, bấm “Dựng lại”'); });
    if (b.reel && (media.type !== 'video' || !files.length)) throw httpErr(400, 'Chưa có video. Mở “Xem bài”, đợi app dựng video xong rồi đăng.');
    const message = [String(post.caption).trim(), (post.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
    if (/\[cần số thật|\[số thật\]/i.test(message)) throw httpErr(400, 'Caption còn chỗ [cần số thật], phải sửa trước khi đăng');
    // Giờ đăng: hẹn đúng giờ trong lịch (Facebook nhận hẹn từ 10 phút đến 29 ngày tới), giờ đã qua thì đăng ngay.
    const nowS = Math.floor(Date.now() / 1000), want = etEpoch(post.publish?.date || root.postDate, post.publish?.time_et || root.postTime || '19:00');
    const sched = !body.now && want && want > nowS + 15 * 60 && want < nowS + 29 * 86400 ? want : null;
    const S = sched ? { published: false, scheduled_publish_time: sched } : {};
    let out;
    if (b.reel) try {
      const st = await graphPost(`/${fbId}/video_reels`, { upload_phase: 'start' }, token);
      const buf = await fs.readFile(files[0]);
      const up = await fetch(st.upload_url || `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${st.video_id}`, { method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(buf.length) }, body: buf });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok || uj.error || uj.success === false) throw new Error('Tải video lên Facebook lỗi: ' + (uj.error?.message || uj.debug_info?.message || up.status));
      await graphPost(`/${fbId}/video_reels`, { upload_phase: 'finish', video_id: st.video_id, description: message, video_state: sched ? 'SCHEDULED' : 'PUBLISHED', scheduled_publish_time: sched || undefined }, token);
      out = { type: 'reel', videoId: st.video_id, url: `https://www.facebook.com/reel/${st.video_id}` };
    } catch (e) {
      if (!/mã 200\)|permission/i.test(e.message)) throw e;
      // Facebook chặn Reel với tài khoản chỉ có quyền tạo nội dung: đăng video dọc qua /videos (Facebook tự hiển thị như Reel).
      try {
        const r = await graphUpload(`/${fbId}/videos`, { description: message, ...(sched ? { published: false, scheduled_publish_time: sched } : {}) }, token, files[0], `https://graph-video.facebook.com/${GRAPH_VERSION}`);
        out = { type: 'video', videoId: r.id, url: `https://www.facebook.com/${r.id}`, via: 'videos' };
      } catch (e2) {
        throw httpErr(403, `Facebook không cho tài khoản này đăng video lên page “${ws.pages[root.pageId]?.name || fbId}” (${e2.message}). Tài khoản của bạn chỉ có quyền tạo nội dung, chưa có toàn quyền page. Vào page trên Facebook → Cài đặt → Thiết lập Trang → Quyền truy cập Trang → cấp cho tài khoản của bạn “toàn quyền” (Full control), rồi vào Kết nối Facebook đăng nhập lại.`);
      }
    }
    else if (files.length === 1) {
      const r = await graphUpload(`/${fbId}/photos`, { caption: message, ...S }, token, files[0]);
      const pid = r.post_id || r.id; out = { type: 'photo', postId: pid, url: `https://www.facebook.com/${pid}` };
    } else if (files.length > 1) {
      const ids = [];
      for (const f of files.slice(0, 10)) ids.push((await graphUpload(`/${fbId}/photos`, { published: false, temporary: sched ? true : undefined }, token, f)).id);
      const params = { message, ...S }; ids.forEach((id, i) => { params[`attached_media[${i}]`] = { media_fbid: id }; });
      const r = await graphPost(`/${fbId}/feed`, params, token);
      out = { type: 'album', postId: r.id, url: `https://www.facebook.com/${String(r.id).replace('_', '/posts/')}` };
    } else {
      const r = await graphPost(`/${fbId}/feed`, { message, ...S }, token);
      out = { type: 'text', postId: r.id, url: `https://www.facebook.com/${String(r.id).replace('_', '/posts/')}` };
    }
    const pub = { auto: !!auto, at: Date.now(), mode: sched ? 'hen-gio' : 'ngay', when: (sched || nowS) * 1000, pageId: root.pageId, fbPageId: String(fbId), ...out };
    await withWs(db => {
      const doc = db.settings.published ||= { id: 'published', posts: {} }; doc.posts ||= {}; doc.posts[root.id] = pub;
      const r = db.tasks[root.id];
      if (r) { r.published = pub; r.updatedAt = Date.now(); (r.history ||= []).push({ at: Date.now(), who: auto?.by || 'ban', text: (auto ? 'Leader tự duyệt và đăng (thay Tuyết). ' : 'Bạn duyệt đăng. ') + (sched ? `Đã gửi lên Facebook, hẹn đăng ${new Date(sched * 1000).toLocaleString('vi-VN')}` : 'Đã đăng lên Facebook') }); }
    });
    return pub;
  }
}
const httpErr = (code, msg) => Object.assign(new Error(msg), { code });
app.post('/api/posts/:id/publish', async (req, res) => {
  try { res.json({ ok: true, published: await publishPost(req.params.id, req.body || {}) }); }
  catch (err) { res.status(err.code || 502).json({ error: err.message }); }
});

// Dán token tạo ở Graph API Explorer (Tools) thay cho đăng nhập: đổi sang token dài hạn, đọc danh sách page và token từng page.
// Token chỉ lưu trong data/store.json trên máy này, không trả về trình duyệt.
app.post('/api/accounts/token', async (req, res) => {
  const raw = String(req.body?.token || '').trim();
  if (!/^[A-Za-z0-9_-]{40,}$/.test(raw)) return res.status(400).json({ error: 'Token không đúng dạng. Copy nguyên ô Access Token trong Graph API Explorer rồi dán lại.' });
  try {
    let tok = raw, exp = null;
    if (FB_ENABLED) { try { const long = await graph('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: FB_APP_ID, client_secret: FB_APP_SECRET, fb_exchange_token: raw }); tok = long.access_token || raw; exp = long.expires_in ? Date.now() + long.expires_in * 1000 : null; } catch {} }
    const me = await graph('/me', { fields: 'id,name', access_token: tok });
    let pages = null; try { pages = await listPages(tok); } catch {}
    const db = await load();
    if (pages && pages.length) {
      db.accounts[me.id] = { id: me.id, name: me.name, userToken: tok, tokenExpiresAt: exp, pages, connected: db.accounts[me.id]?.connected || [], updatedAt: Date.now() };
    } else {
      // Token của một page: gắn page đó vào tài khoản đang có.
      const acc = Object.values(db.accounts)[0] || (db.accounts.manual = { id: 'manual', name: 'Token dán tay', userToken: '', pages: [], connected: [] });
      acc.pages = [...(acc.pages || []).filter(p => p.id !== me.id), { id: me.id, name: me.name, tasks: [], pageToken: tok }]; acc.updatedAt = Date.now();
    }
    await save(db);
    res.json({ ok: true, name: me.name, pages: pages?.length || 1, list: (pages || [{ name: me.name }]).map(p => p.name) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Kiểm tra quyền của token đã lưu (không trả token ra ngoài): token thuộc app nào, còn hạn không, có những quyền gì.
app.get('/api/accounts/check', async (req, res) => {
  const db = await load(), out = [], appTok = FB_ENABLED ? `${FB_APP_ID}|${FB_APP_SECRET}` : null;
  const dbg = async t => (await graph('/debug_token', { input_token: t, access_token: appTok })).data || {};
  for (const a of Object.values(db.accounts || {})) {
    const r = { id: a.id, name: a.name, pages: (a.pages || []).map(p => p.name), updatedAt: a.updatedAt || null };
    if (a.userToken) {
      try { const p = await graph('/me/permissions', { access_token: a.userToken }); r.granted = p.data.filter(x => x.status === 'granted').map(x => x.permission); r.declined = p.data.filter(x => x.status !== 'granted').map(x => x.permission); } catch (e) { r.userErr = e.message; }
      if (appTok) try { const d = await dbg(a.userToken); r.tokenApp = d.app_id; r.tokenAppName = d.application; r.valid = d.is_valid; r.expiresAt = d.expires_at ? d.expires_at * 1000 : 0; r.scopes = d.scopes; } catch (e) { r.debugErr = e.message; }
    }
    const pg = (a.pages || []).find(p => p.pageToken);
    if (pg && appTok) try { const d = await dbg(pg.pageToken); r.pageCheck = { page: pg.name, app: d.app_id, valid: d.is_valid, scopes: d.scopes }; } catch (e) { r.pageErr = e.message; }
    out.push(r);
  }
  res.json({ appId: FB_APP_ID || null, accounts: out });
});


// ---------- Số liệu page (Graph API), mục tiêu, việc phân tích số liệu hằng ngày của Leader ----------
// Lưu ở data/metrics.json. Thu mỗi 3 giờ (và khi bấm “Cập nhật số liệu”). Tên chỉ số của Meta hay đổi nên thử lần lượt nhiều tên.
const METRICS_FILE = path.join(__dirname, 'data', 'metrics.json');
let METRICS = { pages: {}, at: 0 };
fs.readFile(METRICS_FILE, 'utf8').then(t => { METRICS = JSON.parse(t); METRICS.pages ||= {}; }).catch(() => {});
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sumLast = (obj, n, off = 0) => { const ks = Object.keys(obj || {}).sort(); return ks.slice(Math.max(0, ks.length - n - off), ks.length - off).reduce((x, k) => x + (+obj[k] || 0), 0); };
async function tryMetrics(pathname, names, params, token) {
  for (const m of names) { try { const j = await graph(pathname, { metric: m, ...params, access_token: token }); if (j.data?.length) return { name: m, data: j.data[0] }; } catch {} }
  return null;
}
const tokenFor = (store, fbId) => Object.values(store.accounts || {}).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).flatMap(a => a.pages || []).find(p => p.id === String(fbId) && p.pageToken)?.pageToken || null;
let collecting = null;
function collectMetrics() {
  if (collecting) return collecting;
  collecting = (async () => {
    const ws = await loadWs(), store = await load(), now = Date.now(), since = Math.floor((now - 35 * 864e5) / 1000), until = Math.floor(now / 1000);
    for (const pg of Object.values(ws.pages || {})) {
      if (!pg.fbId) continue;
      const m = METRICS.pages[pg.fbId] ||= { followersByDay: {}, viewsByDay: {}, engByDay: {}, posts: {} };
      m.name = pg.name; m.pageId = pg.id;
      const token = tokenFor(store, pg.fbId);
      if (!token) { m.error = 'Chưa có token của page này'; continue; }
      try {
        const info = await graph(`/${pg.fbId}`, { fields: 'followers_count,fan_count', access_token: token });
        m.followers = info.followers_count ?? info.fan_count ?? 0; m.followersByDay[dayKey(now)] = m.followers;
        const v = await tryMetrics(`/${pg.fbId}/insights`, ['page_media_view', 'page_impressions', 'page_impressions_unique'], { period: 'day', since, until }, token);
        if (v) { m.viewsMetric = v.name; for (const x of v.data.values || []) m.viewsByDay[dayKey(Date.parse(x.end_time) - 864e5)] = +x.value || 0; }
        // Tiếp cận theo ngày của cả page (người xem duy nhất trong ngày), không gắn với ngày đăng bài.
        const rc = await tryMetrics(`/${pg.fbId}/insights`, ['page_total_media_view_unique', 'page_impressions_unique', 'page_media_view_unique'], { period: 'day', since, until }, token);
        if (rc) { m.reachByDay ||= {}; m.reachMetric = rc.name; for (const x of rc.data.values || []) m.reachByDay[dayKey(Date.parse(x.end_time) - 864e5)] = +x.value || 0; }
        const e = await tryMetrics(`/${pg.fbId}/insights`, ['page_post_engagements'], { period: 'day', since, until }, token);
        if (e) for (const x of e.data.values || []) m.engByDay[dayKey(Date.parse(x.end_time) - 864e5)] = +x.value || 0;
        const posts = await graph(`/${pg.fbId}/published_posts`, { fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', limit: '25', access_token: token }).catch(() => ({ data: [] }));
        for (const p of posts.data || []) {
          const o = m.posts[p.id] ||= {};
          Object.assign(o, { id: p.id, text: String(p.message || '').slice(0, 160), at: Date.parse(p.created_time), url: p.permalink_url || '', reactions: p.reactions?.summary?.total_count || 0, comments: p.comments?.summary?.total_count || 0, shares: p.shares?.count || 0 });
          if (now - o.at < 15 * 864e5 || o.views == null) { const pv = await tryMetrics(`/${p.id}/insights`, ['post_media_view', 'post_impressions'], { period: 'lifetime' }, token); if (pv) o.views = +pv.data.values?.[0]?.value || 0; }
        }
        const reels = await graph(`/${pg.fbId}/video_reels`, { fields: 'id,description,created_time,permalink_url', limit: '15', access_token: token }).catch(() => ({ data: [] }));
        for (const r of reels.data || []) {
          const o = m.posts['v' + r.id] ||= {};
          Object.assign(o, { id: r.id, reel: true, text: String(r.description || '').slice(0, 160), at: Date.parse(r.created_time), url: r.permalink_url ? (/^http/.test(r.permalink_url) ? r.permalink_url : 'https://www.facebook.com' + r.permalink_url) : '' });
          if (now - o.at < 15 * 864e5 || o.views == null) {
            const rv = await tryMetrics(`/${r.id}/video_insights`, ['fb_reels_total_plays', 'blue_reels_play_count', 'post_impressions_unique'], {}, token); if (rv) o.views = +rv.data.values?.[0]?.value || 0;
            try { const sc = await graph(`/${r.id}`, { fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0)', access_token: token }); o.reactions = sc.likes?.summary?.total_count || 0; o.comments = sc.comments?.summary?.total_count || 0; } catch {}
          }
        }
        m.error = v ? null : 'Không đọc được lượt hiển thị (cần quyền read_insights)'; m.updatedAt = now;
      } catch (err) { m.error = err.message; }
    }
    METRICS.at = Date.now();
    await fs.writeFile(METRICS_FILE, JSON.stringify(METRICS));
    await syncGoals();
    await ensureMetricsTask();
  })().finally(() => { collecting = null; });
  return collecting;
}
// Mục tiêu tự cập nhật: người theo dõi lấy số hiện tại, lượt hiển thị cộng dồn từ ngày bắt đầu tới hạn.
function syncGoals() {
  return withWs(db => {
    let ch = false;
    for (const g of Object.values(db.goals || {})) {
      if (!g.auto) continue; const pg = db.pages[g.pageId], m = pg && METRICS.pages[pg.fbId]; if (!m) continue;
      const cur = g.auto === 'followers' ? (m.followers ?? g.current) : Object.entries(m.viewsByDay || {}).filter(([d]) => d >= (g.start || '') && d <= (g.due || '9999')).reduce((x, [, v]) => x + v, 0);
      if (cur !== g.current) { g.current = cur; g.updatedAt = Date.now(); ch = true; }
    }
    return ch ? undefined : { save: false };
  });
}
function postLabel(db, p) {
  const hit = Object.entries(db.settings.published?.posts || {}).find(([, x]) => x.postId === p.id || x.videoId === p.id || String(x.postId || '').endsWith('_' + p.id));
  const r = hit && db.tasks[hit[0]]; return r ? { title: r.title, pillar: r.pillar || null, format: r.format || null } : {};
}
// Số liệu của một page, gọn để đưa vào task của agent.
function perfBrief(db, pageId, nTop = 3) {
  const pg = db.pages[pageId], m = pg && METRICS.pages[pg.fbId]; if (!m) return null;
  const posts = Object.values(m.posts || {}).filter(p => p.at).map(p => ({ ...postLabel(db, p), text: p.text, reel: !!p.reel, views: p.views ?? null, reactions: p.reactions || 0, comments: p.comments || 0, shares: p.shares || 0, daysAgo: Math.round((Date.now() - p.at) / 864e5),
    score: (p.views || 0) + 20 * ((p.reactions || 0) + 3 * (p.comments || 0) + 5 * (p.shares || 0)) })).sort((a, b) => b.score - a.score);
  const goals = Object.values(db.goals || {}).filter(g => g.pageId === pageId && g.auto).map(g => {
    const left = Math.max(1, Math.round((Date.parse(g.due) - Date.now()) / 864e5));
    return { goal: g.title, current: g.current || 0, target: +g.target, due: g.due, daysLeft: left, neededPerDay: Math.max(0, Math.ceil((+g.target - (g.current || 0)) / left)) };
  });
  const strat = db.settings.strategy?.pages?.[pageId];
  return { page: pg.name, pageId, followers: m.followers ?? null, followers7dAgo: m.followersByDay ? Object.entries(m.followersByDay).sort().slice(-8)[0]?.[1] ?? null : null,
    views7d: sumLast(m.viewsByDay, 7), viewsPrev7d: sumLast(m.viewsByDay, 7, 7), engagement7d: sumLast(m.engByDay, 7), goals, postsTracked: posts.length,
    top: posts.slice(0, nTop).map(({ score, ...x }) => x), weak: posts.length > nTop + 2 ? posts.slice(-2).map(({ score, ...x }) => x) : [], error: m.error || null,
    leaderStrategy: strat ? { at: new Date(strat.at).toISOString().slice(0, 10), brief: strat.text, actions: strat.actions } : null };
}
const metricsBrief = db => Object.values(db.pages || {}).filter(p => p.fbId).map(p => perfBrief(db, p.id, 5)).filter(Boolean);
// Mỗi ngày một việc cho Leader: đọc số liệu mọi page, so với mục tiêu, viết chiến lược cho Content.
function ensureMetricsTask() {
  const today = todayLocal(), id = `tk_metrics_${today}`;
  return withWs(db => {
    if (db.tasks[id] || !Object.values(METRICS.pages).some(m => m.updatedAt)) return { save: false };
    const L = Object.values(db.agents).find(a => roleOf(a) === 'leader'); if (!L) return { save: false };
    const si = L.steps.findIndex(st => st.name === 'Phân tích số liệu'); if (si < 0) return { save: false };
    const at = Date.now();
    db.tasks[id] = { id, kind: 'metrics', title: `Số liệu ${today.split('-').reverse().slice(0, 2).join('/')}: đánh giá và chiến lược`, desc: 'Đọc số liệu các page trong task.metrics, so với mục tiêu tháng, rút ra bài nào hiệu quả và vì sao, rồi viết chiến lược nội dung cho từng page.',
      from: L.id, to: 'ban', agentId: L.id, status: 'moi', step: si, until: si, noReview: true, returns: 0, outputs: [], history: [{ at, who: L.id, text: 'Hệ thống tạo việc đánh giá số liệu hằng ngày' }], createdAt: at, updatedAt: at };
  });
}
app.get('/api/metrics', (req, res) => res.json(METRICS));
app.post('/api/metrics/refresh', async (req, res) => { try { await collectMetrics(); res.json({ ok: true, at: METRICS.at }); } catch (err) { res.status(502).json({ error: err.message }); } });
setTimeout(() => collectMetrics().catch(() => {}), 30e3); setInterval(() => collectMetrics().catch(() => {}), 3 * 3600e3);


// ---------- Dựng Reel bằng HyperFrames (chạy trên máy này) ----------
// Editor nộp khối `hf` { voice, speed, mood, lines: ["cảnh|lời"], html }. Khi Leader chấm đạt (hoặc bạn bấm “Dựng bằng HyperFrames”),
// server tạo thư mục data/hf/<bài>, chép bộ kit templates/hf-kit, tạo giọng đọc + nhạc (make.py), render MP4 rồi gắn vào bài.
// Cần: Node.js 22+, FFmpeg, Python có kokoro-onnx + soundfile + numpy, và `npm install hyperframes` trong thư mục AUTOFB.
const HF_KIT = path.join(__dirname, 'templates', 'hf-kit');
const HF_DIR = path.join(__dirname, 'data', 'hf');
const IS_WIN = process.platform === 'win32';
// Tìm FFmpeg/FFprobe thật (kể cả bản winget cài sau khi mở cửa sổ chạy server) và chỉ thẳng cho HyperFrames.
let FFMPEG_FOUND = null; const SERVER_START = Date.now();
(function findFfmpeg() {
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg', probe = IS_WIN ? 'ffprobe.exe' : 'ffprobe', la = process.env.LOCALAPPDATA || '', cands = [];
  for (const d of (process.env.PATH || '').split(IS_WIN ? ';' : ':')) if (d) cands.push(path.join(d, exe));
  if (IS_WIN) {
    cands.push(path.join(la, 'Microsoft', 'WinGet', 'Links', exe));
    const pk = path.join(la, 'Microsoft', 'WinGet', 'Packages');
    try { for (const d of fss.readdirSync(pk).filter(n => /ffmpeg/i.test(n))) for (const sub of fss.readdirSync(path.join(pk, d))) cands.push(path.join(pk, d, sub, 'bin', exe), path.join(pk, d, sub, exe)); } catch {}
    cands.push('C:\\ffmpeg\\bin\\' + exe, 'C:\\Program Files\\ffmpeg\\bin\\' + exe, path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', exe));
  }
  for (const c of cands) {
    try { if (!fss.existsSync(c)) continue; const real = fss.realpathSync(c), dir = path.dirname(real), pr = path.join(dir, probe);
      if (!fss.existsSync(pr)) continue;
      FFMPEG_FOUND = real; process.env.HYPERFRAMES_FFMPEG_PATH ||= real; process.env.HYPERFRAMES_FFPROBE_PATH ||= pr;
      process.env.PATH = dir + (IS_WIN ? ';' : ':') + process.env.PATH; console.log('FFmpeg cho HyperFrames:', real); return; } catch {}
  }
  console.warn('Không tìm thấy FFmpeg. Cài: winget install Gyan.FFmpeg rồi chạy lại npm start.');
})();
if (IS_WIN) { const la = process.env.LOCALAPPDATA || '';
  for (const v of ['313', '312', '311']) { const d = path.join(la, 'Programs', 'Python', 'Python' + v); if (fss.existsSync(path.join(d, 'python.exe'))) { process.env.PATH = d + ';' + path.join(d, 'Scripts') + ';' + process.env.PATH; break; } } }

const hfAvailable = () => fss.existsSync(path.join(__dirname, 'node_modules', 'hyperframes')) && fss.existsSync(path.join(HF_KIT, 'make.txt'));
function runCmd(cmd, args, cwd, timeoutMs, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: IS_WIN, env: { ...process.env, ...env }, windowsHide: true });
    let out = ''; const add = d => { out = (out + d).slice(-6000); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const tm = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('Quá thời gian chạy ' + cmd)); }, timeoutMs);
    p.on('error', e => { clearTimeout(tm); reject(e); });
    p.on('exit', code => { clearTimeout(tm); code ? reject(new Error(`${cmd} lỗi (mã ${code}): ${out.slice(-1500)}`)) : resolve(out); });
  });
}
// Tìm Python thật. Trên Windows lệnh “python” có thể là lối tắt Microsoft Store (lỗi 9009), nên thử py -3 và các chỗ cài thường gặp.
let PY = null;
async function findPython() {
  if (PY) return PY;
  const qa = x => IS_WIN ? `"${x}"` : x;
  const la = process.env.LOCALAPPDATA || '', cands = [];
  if (process.env.PYTHON) cands.push([process.env.PYTHON, []]);
  if (IS_WIN) {
    cands.push(['py', ['-3']]);
    for (const v of ['313', '312', '311', '310']) { const f = path.join(la, 'Programs', 'Python', 'Python' + v, 'python.exe'); if (fss.existsSync(f)) cands.push([f, []]); }
    cands.push(['python', []], ['python3', []]);
  } else cands.push(['python3', []], ['python', []]);
  const q = c => IS_WIN && /\s/.test(c) && !c.startsWith('"') ? `"${c}"` : c;
  const seen = new Set(), bad = [];
  for (const [c, a] of cands) {
    let exe;
    try { exe = (await runCmd(q(c), [...a, '-c', qa("print(__import__('sys').executable)")], __dirname, 20e3)).trim().split(/\r?\n/).pop().trim(); } catch { continue; }
    if (!exe || /WindowsApps/i.test(exe) || !fss.existsSync(exe) || seen.has(exe.toLowerCase())) continue; seen.add(exe.toLowerCase());
    try { await runCmd(q(exe), ['-c', qa("import kokoro_onnx,soundfile;print('ok')")], __dirname, 60e3); PY = exe; console.log('Python cho HyperFrames:', exe); return PY; }
    catch (e) { const why = String(e.message).split(/\r?\n/).map(x => x.trim()).filter(Boolean).filter(x => /Error|error|No module/.test(x)).pop() || 'không import được'; bad.push(`${exe}: ${why.slice(0, 220)}`); }
  }
  if (bad.length) {
    const dll = bad.some(x => /DLL/i.test(x));
    throw new Error(`Python chưa dùng được gói giọng đọc. ${bad.join(' | ')}. ` + (dll ? 'Lỗi DLL: cài Microsoft Visual C++ Redistributable (winget install Microsoft.VCRedist.2015+.x64), rồi chạy lại npm start.' : `Chạy: "${bad[0].split(': ')[0]}" -m pip install kokoro-onnx soundfile numpy  rồi bấm Dựng lại.`));
  }
  throw new Error('Không tìm thấy Python 3 trên máy. Cài Python 3.12 (winget install Python.Python.3.12), mở lại cửa sổ PowerShell rồi chạy lại npm start.');
}
// Kiểu dựng riêng theo page (định nghĩa trong templates/hf-kit/assets/core.js).
const lookOf = n => /renter/i.test(n) ? 'renter' : /\$5 plate|budget protein/i.test(n) ? 'plate' : /dog/i.test(n) ? 'dog' : /walking pad|10k/i.test(n) ? 'walkpad' : /sweatpants/i.test(n) ? 'sweatpants' : /remember when|80s|90s/i.test(n) ? 'remember' : '';
function hfSpec(db, b) {
  for (const t of [...b.ts].reverse()) { if (t.superseded || roleOf(db.agents[t.agentId] || {}) !== 'editor') continue;
    for (const o of [...(t.outputs || [])].reverse()) { const d = parseJson(o.text); if (d?.hf && Array.isArray(d.hf.lines) && d.hf.lines.length && (d.hf.html || (Array.isArray(d.hf.shots) && d.hf.shots.length))) return d.hf; } }
  return null;
}
const hfSet = (rid, patch) => withWs(db => { const r = db.tasks[rid]; if (!r) return { save: false }; Object.assign(r, patch); r.updatedAt = Date.now(); });
const hfQueue = []; let hfBusy = false;
let hfCur = null;
function hfEnqueue(rid) { if (rid === hfCur || hfQueue.includes(rid)) return; hfQueue.push(rid); hfSet(rid, { hfJob: { status: 'cho', at: Date.now() } }).catch(() => {}); hfPump(); }
async function hfPump() {
  if (hfBusy || !hfQueue.length) return; hfBusy = true; const rid = hfQueue.shift(); hfCur = rid;
  try { await hfRender(rid); } catch (err) { await hfSet(rid, { hfJob: { status: 'loi', at: Date.now(), error: String(err.message || err).slice(0, 1500) } }).catch(() => {}); console.error('HyperFrames lỗi:', err.message); }
  hfBusy = false; hfCur = null; hfPump();
}
// ----- Muse (muse2api tự lưu trữ): tạo cảnh quay AI -----
// .env: MUSE2API_BASE=http://127.0.0.1:18610  MUSE2API_KEY=...  (MUSE_MAX_PER_DAY=30 tùy chọn)
const MUSE_KEY = String(process.env.MUSE2API_KEY || process.env.MUSE_API_KEY || '').trim();
const MUSE_BASE = String(process.env.MUSE2API_BASE || process.env.MUSE_BASE || process.env.MUSE_API_BASE || (MUSE_KEY ? 'http://127.0.0.1:18610' : '')).trim().replace(/\/+$/, '');
const museOn = () => !!(MUSE_BASE && MUSE_KEY);
async function museFetch(p, opt = {}) {
  const r = await fetch(MUSE_BASE + p, { ...opt, headers: { Authorization: `Bearer ${MUSE_KEY}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Muse: ' + (j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || r.status));
  return j;
}
const musePick = j => j?.url || j?.video_url || j?.output?.url || j?.result?.url || j?.data?.[0]?.url || j?.data?.url || j?.videos?.[0]?.url || j?.video?.url || null;
async function museVideo(prompt, dur, file) {
  const job = await museFetch('/v1/videos', { method: 'POST', body: JSON.stringify({ prompt, duration: dur, size: '9:16' }) });
  let j = job; const t0 = Date.now(), id = job.id || job.task_id;
  while (!musePick(j)) {
    if (/fail|error|cancel|reject/i.test(String(j.status || ''))) throw new Error('Muse không tạo được cảnh: ' + (j.error?.message || j.error || j.status));
    if (!id) throw new Error('Muse không trả mã tác vụ');
    if (Date.now() - t0 > 10 * 60e3) throw new Error('Muse tạo cảnh quá 10 phút');
    await new Promise(r => setTimeout(r, 6000));
    j = await museFetch('/v1/videos/' + encodeURIComponent(id));
  }
  let u = musePick(j); if (u.startsWith('/')) u = MUSE_BASE + u;
  const r = await fetch(u, u.startsWith(MUSE_BASE) ? { headers: { Authorization: `Bearer ${MUSE_KEY}` } } : {}); if (!r.ok) throw new Error('Tải cảnh từ Muse lỗi ' + r.status);
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
}
// Giới hạn số cảnh mỗi ngày (mặc định 30) để không dùng quá tay tài khoản.
async function museTake(n) {
  return withWs(db => { const m = db.settings.muse ||= { id: 'muse', usage: {} }; m.usage ||= {}; m.maxPerDay = +process.env.MUSE_MAX_PER_DAY || m.maxPerDay || 30;
    const d = todayLocal(), used = m.usage[d] || 0; if (used + n > m.maxPerDay) return { save: false, ok: false, used, max: m.maxPerDay };
    m.usage[d] = used + n; return { ok: true, used: used + n, max: m.maxPerDay }; });
}
// Chèn cảnh quay (video) nằm dưới lớp đồ họa của từng cảnh, cùng thời gian với cảnh đó.
function injectClips(tpl, scenes) {
  if (!scenes.length) return tpl;
  const v = scenes.map(n => `<video class="clip" data-scene="s${n}" data-start="__S${n}__" data-duration="__D${n}__" src="assets/clips/s${n}.mp4" muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`).join('');
  const m = /<div[^>]*\bid=["']s1["']/i.exec(tpl); if (!m) return tpl;
  return tpl.slice(0, m.index) + v + tpl.slice(m.index);
}
// Khuôn phim ngắn mặc định: mỗi cảnh = cảnh quay Muse (nằm dưới) + lớp tối nhẹ + tiêu đề ngắn (nếu có). Phụ đề, chuyển cảnh theo kiểu của page.
const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function storyTpl(hf) {
  const ns = [...new Set(hf.lines.map(l => +String(l).split('|')[0]).filter(n => n > 0))].sort((a, b) => a - b);
  const title = n => (hf.shots || []).find(x => +x.scene === n)?.title || '';
  return `<!doctype html><html><head><meta charset="utf-8"><script src="assets/gsap.min.js"></script><script src="assets/core.js"></script>
<style>@font-face{font-family:'Inter';font-weight:700;src:url(assets/fonts/inter-latin-700-normal.woff2) format('woff2')}@font-face{font-family:'Inter';font-weight:800;src:url(assets/fonts/inter-latin-800-normal.woff2) format('woff2')}
body{margin:0;background:#000}#root{position:relative;width:1080px;height:1920px;overflow:hidden;background:#0d0d12}.clip{position:absolute;inset:0}
#cap{position:absolute;left:120px;right:190px;top:1180px;height:150px;z-index:30}.cl{position:absolute;inset:0;display:flex;flex-wrap:wrap;justify-content:center;align-content:center;gap:4px 12px;opacity:0}
.cw{font:700 44px/1.15 'Inter',Arial,sans-serif;color:#fff;padding:3px 10px;border-radius:10px;text-shadow:0 3px 16px rgba(0,0,0,.7)}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.5) 0%,rgba(0,0,0,0) 30%,rgba(0,0,0,0) 52%,rgba(0,0,0,.6) 100%)}
.tt{position:absolute;left:110px;right:150px;top:290px;font:800 72px/1.06 'Inter',Arial,sans-serif;color:#fff;text-shadow:0 6px 28px rgba(0,0,0,.75)}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="__T__" data-width="1080" data-height="1920">
<div id="bg" class="clip" data-start="0" data-duration="__T__" style="background:radial-gradient(ellipse at 50% 35%,#2a2a3a,#0d0d12 70%)"></div>
${ns.map(n => `<div id="s${n}" class="clip" data-start="__S${n}__" data-duration="__D${n}__"><div class="shade"></div>${title(n) ? `<div class="tt">${escH(title(n))}</div>` : ''}</div>`).join('\n')}
<div class="clip" data-start="0" data-duration="__T__"><div id="cap"></div></div>
<audio data-start="0" data-duration="__T__" src="assets/mix.wav" data-volume="1"></audio>
</div>
<script id="timing" type="application/json">__TIMING__</script>
<script>const K = reelKit({ capActive:'#FFD166', capInk:'#111111' }), { tl, D } = K;
document.querySelectorAll('video.clip').forEach((v, i) => { const sc = D.scenes.find(x => 's' + x.id === v.dataset.scene) || D.scenes[i]; if (sc) tl.fromTo(v, { scale: 1 }, { scale: 1.08, duration: Math.max(.5, sc.end - sc.start), ease: 'none' }, sc.start); });
D.scenes.forEach(sc => { const t = document.querySelector('#s' + sc.id + ' .tt'); if (t) tl.from(t, { opacity: 0, y: 40, duration: .5, ease: 'power3.out' }, sc.start + .25); });
K.done();</script></body></html>`;
}
async function hfRender(rid) {
  if (!hfAvailable()) throw new Error('Máy chưa cài HyperFrames: chạy “npm install hyperframes” trong thư mục AUTOFB (cần Node.js 22+, FFmpeg, Python).');
  const ws = await loadWs(); for (const c of COLLS) ws[c] ||= {};
  const b = postBundle(ws, rid); if (!b?.reel) throw new Error('Bài này không phải Reel');
  if (!FFMPEG_FOUND) throw new Error('Máy chưa tìm thấy FFmpeg (cần để xuất video). Mở PowerShell chạy: winget install Gyan.FFmpeg, sau đó đóng hết cửa sổ PowerShell, mở cửa sổ mới và chạy lại npm start.');
  const hf = hfSpec(ws, b); if (!hf) throw new Error('Editor chưa nộp bản dựng HyperFrames (khối hf). Bấm “Yêu cầu làm lại” cho Editor.');
  await hfSet(rid, { hfJob: { status: 'dang-dung', at: Date.now() } });
  const dir = path.join(HF_DIR, rid + '_' + Date.now().toString(36));
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(path.join(HF_KIT, 'assets'), path.join(dir, 'assets'), { recursive: true });
  if (fss.existsSync(path.join(HF_KIT, 'hyperframes.json'))) await fs.copyFile(path.join(HF_KIT, 'hyperframes.json'), path.join(dir, 'hyperframes.json'));
  const look = lookOf(ws.pages[b.root.pageId]?.name || '');
  const baseHtml = hf.html ? String(hf.html) : storyTpl(hf);
  let tpl = look ? baseHtml.replace(/<head[^>]*>/i, m => `${m}<script>window.__LOOK='${look}'</script>`) : baseHtml, museNote = '';
  const shots = Array.isArray(hf.shots) ? hf.shots.filter(x => x && x.prompt && +x.scene > 0 && +x.scene < 20).slice(0, 8) : [];
  if (shots.length && museOn()) {
    const q = await museTake(shots.length);
    if (!q.ok) museNote = `Đã dùng hết ${q.max} cảnh Muse hôm nay, video dựng bằng đồ họa.`;
    else {
      await fs.mkdir(path.join(dir, 'assets', 'clips'), { recursive: true }); const got = [], errs = [];
      for (const [i, sh] of shots.entries()) {
        await hfSet(rid, { hfJob: { status: 'dang-dung', at: Date.now(), step: `Muse đang tạo cảnh quay ${i + 1}/${shots.length}` } });
        const words = hf.lines.filter(l => +String(l).split('|')[0] === +sh.scene).join(' ').split(/\s+/).length, est = Math.ceil(words / 2.6 + 1);
        try { await museVideo(String(sh.prompt).slice(0, 1500), Math.min(10, Math.max(5, Math.round(+sh.duration || est))), path.join(dir, 'assets', 'clips', `s${+sh.scene}.mp4`)); got.push(+sh.scene); }
        catch (e) { errs.push(`cảnh ${sh.scene}: ${e.message}`); console.warn('Muse', e.message); }
      }
      tpl = injectClips(tpl, got);
      museNote = `Muse tạo ${got.length}/${shots.length} cảnh quay.` + (errs.length ? ' Lỗi: ' + errs.join('; ').slice(0, 400) : '');
      await hfSet(rid, { hfJob: { status: 'dang-dung', at: Date.now(), step: museNote + ' Đang ghép giọng đọc, phụ đề…' } });
    }
  }
  await fs.writeFile(path.join(dir, 'index.tpl.html'), tpl, 'utf8');
  await fs.writeFile(path.join(dir, 'lines.txt'), hf.lines.map(x => String(x).replace(/\r?\n/g, ' ')).join('\n'), 'utf8');
  const npx = IS_WIN ? 'npx.cmd' : 'npx';
  const py = await findPython(), pyq = IS_WIN && /\s/.test(py) ? `"${py}"` : py;
  await runCmd(pyq, [path.join(HF_KIT, 'make.txt'), dir, String(hf.voice || 'af_heart'), String(hf.speed || 1), String(hf.mood || 'cozy')], dir, 10 * 60e3, { HF_PREFIX: __dirname, PYTHONIOENCODING: 'utf-8', HYPERFRAMES_PYTHON: py });
  const file = `hf_${rid}_${Date.now().toString(36)}.mp4`; await fs.mkdir(MEDIA_DIR, { recursive: true });
  await runCmd(npx, ['--prefix', __dirname, 'hyperframes', 'render', '-o', path.join(MEDIA_DIR, file), '-q', 'standard'], dir, 30 * 60e3);
  const ws2 = await loadWs(); const b2 = postBundle(ws2, rid);
  await hfSet(rid, { media: { type: 'video', files: ['/media/' + file], mime: 'video/mp4', key: b2?.key || b.key, at: Date.now(), own: true, hf: true }, hfJob: { status: 'xong', at: Date.now(), note: museNote || undefined } });
  console.log('HyperFrames: đã dựng ' + file + (museNote ? ' · ' + museNote : ''));
}
app.get('/api/muse/check', async (req, res) => {
  if (!museOn()) return res.json({ ok: false, error: 'Chưa có MUSE_API_KEY trong file .env' });
  let r; try { r = await fetch(MUSE_BASE + '/v1/models', { headers: { Authorization: `Bearer ${MUSE_KEY}` } }); }
  catch (e) { return res.json({ ok: false, base: MUSE_BASE, error: `Không kết nối được tới muse2api ở ${MUSE_BASE}. Kiểm tra muse2api đang chạy, và địa chỉ đúng (thêm dòng MUSE2API_BASE=... vào .env nếu khác).` }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) return res.json({ ok: false, base: MUSE_BASE, error: 'muse2api từ chối key (sai MUSE_API_KEY).' });
  res.json({ ok: r.ok, base: MUSE_BASE, status: r.status, models: (j.data || []).map(m => m.id).slice(0, 30) });
});
app.post('/api/posts/:id/hf-render', async (req, res) => {
  const ws = await loadWs(); const t = ws.tasks?.[req.params.id]; if (!t) return res.status(404).json({ error: 'Không có bài này' });
  if (!hfAvailable()) return res.status(400).json({ error: 'Máy chưa cài HyperFrames: chạy “npm install hyperframes” trong thư mục AUTOFB (cần Node.js 22+, FFmpeg, Python).' });
  hfEnqueue(t.chain || t.id); res.json({ ok: true });
});
// Bài Reel hôm nay đã đạt mà chưa có video dựng sẵn: tự xếp hàng dựng (lúc mở server và mỗi 10 phút).
// ----- Tự duyệt & đăng: Leader chấm đạt (không giữ lại) thì app tự đăng, hẹn đúng giờ trong lịch -----
// Chỉ các page trong settings.autopilot.pages (6 page cũ, bật từ 19/11). Dừng khẩn hoặc tắt autopilot là ngừng.
let RESVG = null; try { RESVG = (await import('@resvg/resvg-js')).Resvg; } catch {}
const dayStr = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Bài ảnh chưa có PNG: server tự xuất từ SVG của Designer (cần gói @resvg/resvg-js).
async function serverImages(b) {
  const src = [...b.ts].reverse().find(t => !t.superseded && t.outputs?.length && roleOf(DBAGENTS[t.agentId] || {}) === 'designer'); if (!src || !RESVG) return false;
  const d = parseJson(src.outputs.at(-1).text) || {}, svgs = (d.assets || d.images || []).map(x => x?.svg).filter(v => /^\s*<svg/i.test(v || ''));
  if (!svgs.length) return false;
  const files = [];
  for (const [i, svg] of svgs.slice(0, 10).entries()) {
    const png = new RESVG(svg, { background: '#ffffff', font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();
    const name = `auto_${b.root.id}_${Date.now()}_${i}.png`; await fs.writeFile(path.join(MEDIA_DIR, name), png); files.push('/media/' + name);
  }
  await withWs(db => { const r = db.tasks[b.root.id]; if (r && !r.media?.own) { r.media = { type: 'images', files, key: b.key, at: Date.now(), by: 'server' }; r.updatedAt = Date.now(); } });
  return true;
}
let DBAGENTS = {}, autoBusy = false;
const autoSweep = async () => {
  if (autoBusy) return; autoBusy = true;
  try {
    let ws = await loadWs(); for (const c of COLLS) ws[c] ||= {}; DBAGENTS = ws.agents;
    const ap = ws.settings.autopilot; if (!ap?.on || ws.settings.main?.paused || ws.settings.main?.limitUntil > Date.now()) return;
    const today = todayLocal(), from = dayStr(Date.now() - 86400e3), to = dayStr(Date.now() + 86400e3);
    const L = Object.values(ws.agents).find(a => roleOf(a) === 'leader');
    const roots = Object.values(ws.tasks).filter(r => r.planPost && !r.chain && !r.superseded && (ap.pages || []).includes(r.pageId) && (r.postDate || '') >= from && (r.postDate || '') <= to && (r.postDate || '') >= (ap.since || today) && !ws.settings.published?.posts?.[r.id])
      .sort((x, y) => (x.postDate + (x.postTime || '')).localeCompare(y.postDate + (y.postTime || '')));
    for (const r0 of roots) {
      if (r0.manualHold || tierOfTask(ws, r0) === 'dung') continue;
      if (r0.autoErr && (r0.autoErr.n >= 3 || Date.now() - r0.autoErr.at < 60 * 60e3)) continue;
      let b = postBundle(ws, r0.id); if (!b?.ready || !b.post) continue;
      const rv = b.ts.filter(x => x.kind === 'review' && x.status === 'xong').at(-1); if (rv?.hold) continue;
      const pubs = Object.values(ws.settings.published?.posts || {});
      if (Object.entries(ws.settings.published?.posts || {}).filter(([rid, p]) => p.auto && p.pageId === r0.pageId && (ws.tasks[rid]?.postDate || dayStr(p.at)) === r0.postDate).length >= (ap.perPage?.[r0.pageId] || ap.maxPerDay || 2)) continue;
      if (b.reel && hfSpec(ws, b) && !b.root.media?.hf && !b.root.media?.own) continue;
      if (b.key && b.root.media?.key !== b.key && !b.root.media?.own) {          // chưa có hình hoặc video đúng bản mới nhất
        if (b.reel || !(await serverImages(b).catch(e => { console.warn('autoImages', e.message); return false; }))) continue;
        ws = await loadWs(); for (const c of COLLS) ws[c] ||= {}; b = postBundle(ws, r0.id);
      }
      try { const pub = await publishPost(r0.id, {}, { by: L?.id || 'leader' }); console.log(`Tự đăng: ${ws.pages[r0.pageId]?.name} · ${r0.title} · ${pub.mode}`); ws = await loadWs(); for (const c of COLLS) ws[c] ||= {}; }
      catch (e) { console.warn('Tự đăng lỗi', r0.title, e.message); await withWs(db => { const x = db.tasks[r0.id]; if (x) { x.autoErr = { at: Date.now(), n: (x.autoErr?.n || 0) + 1, msg: String(e.message).slice(0, 300) }; x.updatedAt = Date.now(); } }); }
    }
  } finally { autoBusy = false; }
};
// Bật một lần cho các page đã kết nối lúc này (6 page cũ).
withWs(db => { if (db.settings.autopilot) return { save: false }; db.settings.autopilot = { id: 'autopilot', on: true, since: todayLocal(), pages: Object.values(db.pages).filter(p => p.fbId).map(p => p.id), maxPerDay: 2, at: Date.now() }; }).catch(() => {});
setTimeout(() => autoSweep().catch(e => console.warn('autoSweep', e.message)), 30e3); setInterval(() => autoSweep().catch(e => console.warn('autoSweep', e.message)), 5 * 60e3);

withWs(db => {
  for (const c of COLLS) db[c] ||= {};
  const mg = db.settings.migr ||= { id: 'migr' }; if (mg.story1120) return { save: false }; mg.story1120 = Date.now();
  const days = [todayLocal(), tomorrowLocal()], now = Date.now();
  for (const r of Object.values(db.tasks)) {
    if (!r.planPost || r.chain || r.superseded || !days.includes(r.postDate) || db.settings.published?.posts?.[r.id] || r.media?.own) continue;
    const b = postBundle(db, r.id); if (!b?.reel) continue;
    const ed = b.ts.filter(t => !t.superseded && t.outputs?.length && roleOf(db.agents[t.agentId] || {}) === 'editor').sort((x, y) => (y.outputs.at(-1).at || 0) - (x.outputs.at(-1).at || 0))[0];
    if (!ed || ed.status !== 'xong') continue;
    const d = parseJson(ed.outputs.at(-1).text); if (Array.isArray(d?.hf?.shots) && d.hf.shots.length) continue;
    const a = db.agents[ed.agentId], last = Number.isInteger(ed.until) ? ed.until : (a?.steps?.length || 1) - 1;
    ed.step = last; ed.status = 'can-sua'; ed.returns = (ed.returns || 0) + 1; delete ed.doneAt; ed.ready = false; if (ed.forwarded === 'done') delete ed.forwarded;
    ed.desc = String(ed.desc || '') + '\n\n## Yêu cầu làm lại (Tuyết, 20/11)\nLàm lại thành PHIM NGẮN theo “Chế độ phim ngắn”: có nhân vật, cốt truyện, 5–7 cảnh. Nộp khối `hf` gồm voice, speed, mood, `lines` (lời kể theo cảnh) và `shots` (mỗi cảnh một cảnh quay cho Muse, có `title` ngắn nếu cần). Không cần viết html.';
    (ed.history ||= []).push({ at: now, who: 'ban', text: 'Làm lại thành phim ngắn: nhân vật, cốt truyện, cảnh quay Muse' }); ed.updatedAt = now;
    console.log('Làm lại thành phim ngắn:', r.title);
  }
}).catch(e => console.warn('story1120', e.message));
// Một lần (20/11): Reel hôm nay và ngày mai có bản dựng cũ chưa có cảnh quay AI → mở lại bước dựng của Editor.
withWs(db => {
  for (const c of COLLS) db[c] ||= {};
  const mg = db.settings.migr ||= { id: 'migr' }; if (mg.shots1120) return { save: false }; mg.shots1120 = Date.now();
  const days = [todayLocal(), tomorrowLocal()], now = Date.now();
  for (const r of Object.values(db.tasks)) {
    if (!r.planPost || r.chain || r.superseded || !days.includes(r.postDate) || db.settings.published?.posts?.[r.id]) continue;
    const b = postBundle(db, r.id); if (!b?.reel) continue;
    const ed = b.ts.filter(t => !t.superseded && t.outputs?.length && roleOf(db.agents[t.agentId] || {}) === 'editor').sort((x, y) => (y.outputs.at(-1).at || 0) - (x.outputs.at(-1).at || 0))[0];
    if (!ed || ed.status !== 'xong') continue;
    const d = parseJson(ed.outputs.at(-1).text); if (!d?.hf || Array.isArray(d.hf.shots)) continue;
    const a = db.agents[ed.agentId], last = Number.isInteger(ed.until) ? ed.until : (a?.steps?.length || 1) - 1;
    ed.step = last; ed.status = 'can-sua'; ed.returns = (ed.returns || 0) + 1; delete ed.doneAt; ed.ready = false; if (ed.forwarded === 'done') delete ed.forwarded;
    (ed.history ||= []).push({ at: now, who: 'ban', text: 'Làm lại bản dựng: thêm cảnh quay AI (shots) cho từng cảnh để Muse dựng, theo mục “Cảnh quay AI (Muse)” trong hướng dẫn. Giữ nội dung, sửa các div cảnh thành lớp chữ trong suốt đè lên cảnh quay.' });
    ed.desc = String(ed.desc || '') + '\n\n## Yêu cầu làm lại (20/11)\nThêm mảng `shots` vào khối `hf` (mỗi cảnh một cảnh quay AI cho Muse, nhân vật cố định của page, khung dọc 9:16, tiếng Anh). Các div cảnh để trong suốt, chỉ đặt chữ và nhãn đè lên cảnh quay. Giữ lời đọc và nội dung.';
    ed.updatedAt = now; console.log('Mở lại bản dựng để thêm cảnh quay AI:', r.title);
  }
}).catch(e => console.warn('shots1120', e.message));
const hfSweep = async () => {
  if (!hfAvailable() || process.env.HF_AUTO === '0') return;
  const ws = await loadWs(); for (const c of COLLS) ws[c] ||= {}; const today = todayLocal();
  for (const r of Object.values(ws.tasks)) {
    if (!r.planPost || r.chain || r.superseded || (r.postDate || '') < today || r.media?.own || ws.settings.published?.posts?.[r.id]) continue;
    const envErr = r.hfJob?.status === 'loi' && /FFmpeg not found|FFprobe not found|kokoro|9009|Python was not found|DLL load failed/i.test(r.hfJob.error || '') && r.hfJob.at < SERVER_START;
    if (r.hfJob && !envErr && (['cho', 'dang-dung'].includes(r.hfJob.status) || (r.hfJob.status === 'loi' && Date.now() - r.hfJob.at < 60 * 60e3))) continue;
    if (r.postDate > tomorrowLocal() || tierOfTask(ws, r) === 'dung') continue;
    const b = postBundle(ws, r.id); if (b?.reel && b.ready && hfSpec(ws, b)) hfEnqueue(r.id);
  }
};
setTimeout(() => hfSweep().catch(() => {}), 20e3); setInterval(() => hfSweep().catch(() => {}), 10 * 60e3);

app.get('/auth/facebook', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now() + 10 * 60 * 1000);
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', FB_APP_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (FB_CONFIG_ID) url.searchParams.set('config_id', FB_CONFIG_ID);
  else url.searchParams.set('scope', SCOPES.join(','));
  res.redirect(url.toString());
});

app.get('/auth/facebook/callback', async (req, res) => {
  const { code, state, error_description: errDesc } = req.query;
  if (errDesc) return res.send(resultPage(false, 'Đăng nhập không thành công', String(errDesc)));
  const exp = states.get(state);
  states.delete(state);
  if (!exp || exp < Date.now()) return res.status(400).send(resultPage(false, 'Phiên đăng nhập đã hết hạn', 'Quay lại dashboard và bấm đăng nhập lần nữa.'));
  try {
    const short = await graph('/oauth/access_token', {
      client_id: FB_APP_ID, client_secret: FB_APP_SECRET, redirect_uri: REDIRECT_URI, code
    });
    const long = await graph('/oauth/access_token', {
      grant_type: 'fb_exchange_token', client_id: FB_APP_ID, client_secret: FB_APP_SECRET,
      fb_exchange_token: short.access_token
    });
    const me = await graph('/me', { fields: 'id,name', access_token: long.access_token });
    const pages = await listPages(long.access_token);
    const db = await load();
    db.accounts[me.id] = {
      id: me.id, name: me.name,
      userToken: long.access_token,
      tokenExpiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : null,
      pages, connected: db.accounts[me.id]?.connected || [], updatedAt: Date.now()
    };
    await save(db);
    res.send(resultPage(true, `Đã kết nối ${me.name}`, `Tìm thấy ${pages.length} page. Tab này sẽ tự đóng, bạn quay lại dashboard nhé.`, me.id));
  } catch (err) {
    res.status(500).send(resultPage(false, 'Lỗi khi kết nối Facebook', err.message));
  }
});

app.get('/api/accounts', async (req, res) => {
  const db = await load();
  res.json(Object.values(db.accounts).map(publicAccount));
});

app.post('/api/accounts/:id/rescan', async (req, res) => {
  const db = await load();
  const a = db.accounts[req.params.id];
  if (!a) return res.status(404).json({ error: 'Không có tài khoản này' });
  try {
    a.pages = await listPages(a.userToken);
    a.updatedAt = Date.now();
    await save(db);
    res.json(publicAccount(a));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/connect', async (req, res) => {
  const db = await load();
  const a = db.accounts[req.params.id];
  if (!a) return res.status(404).json({ error: 'Không có tài khoản này' });
  const ids = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map(String) : [];
  a.connected = [...new Set([...(a.connected || []), ...ids.filter(id => a.pages.some(p => p.id === id))])];
  await save(db);
  res.json(publicAccount(a));
});

app.delete('/api/accounts/:id', async (req, res) => {
  const db = await load();
  delete db.accounts[req.params.id];
  await save(db);
  res.json({ ok: true });
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function resultPage(ok, title, msg, id) {
  const payload = JSON.stringify({ type: 'autofb-fb', ok, id: id || null, t: Date.now() });
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0B0A14;color:#F2F1F8}
.box{max-width:420px;padding:28px;border-radius:18px;background:#1A1826;border:1px solid rgba(255,255,255,.1);text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:rgba(232,230,245,.7);margin:0}.i{font-size:34px;margin-bottom:8px}</style></head>
<body><div class="box"><div class="i">${ok ? '✓' : '!'}</div><h1>${esc(title)}</h1><p>${esc(msg)}</p></div>
<script>
const d = ${payload};
try { if (window.opener) window.opener.postMessage(d, location.origin); } catch (e) {}
try { localStorage.setItem('autofb-login', JSON.stringify(d)); } catch (e) {}
${ok ? 'setTimeout(() => window.close(), 1500);' : ''}
</script></body></html>`;
}

// ---------- Quét chủ đề mỗi sáng ----------
// Mỗi đợt research bật daily.on: đến giờ daily.time (theo daily.tz) thì giao một task quét cho agent research.
// Bản sao scanDesc() trong public/index.html. Sửa thì sửa cả hai.
const MARKET_NAMES = { US: 'Mỹ', UK: 'Anh', CA: 'Canada', AU: 'Úc', VN: 'Việt Nam' };
const SOURCE_NAMES = { trends: 'Google Trends', reddit: 'Reddit', youtube: 'YouTube', tiktok_cc: 'TikTok Creative Center', adlib: 'Meta Ad Library', fbref: 'Page Facebook tham khảo', search: 'Tìm kiếm web và diễn đàn' };
const SCAN_OUTPUT = 'JSON: { topics: [{ title, summary, audience, questions: [], angles: [], demand, growth, engagement, competition, monetization (1–5), reasons: {}, sources: [{ name, url }] }], pageIdeas: [{ name, altNames: [], topics: [], why, audience, monetization_path }], notes }';
function scanDesc(rp, daily) {
  const known = (rp.topics || []).map(t => t.title);
  return `Thị trường: ${MARKET_NAMES[rp.market] || rp.market} (${rp.market}), ngôn ngữ ${rp.language}.\n` +
    `Từ khóa gợi ý: ${String(rp.seeds || '').trim() || 'không có, agent tự tìm'}.\n` +
    `Nguồn được dùng: ${(rp.sources || []).map(k => SOURCE_NAMES[k] || k).join(', ')}.\n` +
    (daily ? `Đây là lượt quét buổi sáng: tìm tối đa ${rp.daily?.count || 10} chủ đề MỚI, ưu tiên thứ đang lên trong 7 ngày qua, và đề xuất 2–3 ý tưởng page từ các chủ đề đó.\n` : 'Tìm 8–15 chủ đề người dùng đang hỏi, than phiền, quan tâm, và đề xuất 2–3 ý tưởng page.\n') +
    (known.length ? `Bỏ qua các chủ đề đã có: ${known.slice(0, 60).join('; ')}.\n` : '') +
    'Chỉ lấy chủ đề và câu hỏi, không chép nội dung. Không đăng, không bình luận, không nhắn tin ở bất kỳ đâu.\n' +
    `Trả về ${SCAN_OUTPUT}`;
}
function localNow(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
async function dailyTick() {
  const made = await withWs(db => {
    if (db.settings.main?.paused) return { save: false, list: [] };
    const list = [];
    for (const rp of Object.values(db.research)) {
      const d = rp.daily;
      if (!d?.on || !rp.marketDone) continue;
      const a = db.agents[rp.agentId] || Object.values(db.agents).find(x => x.template === 'research');
      if (!a) continue;
      let now;
      try { now = localNow(d.tz || 'Asia/Ho_Chi_Minh'); } catch { continue; }
      if (rp.lastAuto === now.date || now.time < (d.time || '08:30')) continue;
      const at = Date.now();
      const id = `tk_auto_${rp.id}_${now.date}`.replace(/[^\w-]/g, '');
      db.tasks[id] = {
        id, title: `Gợi ý sáng ${now.date.split('-').reverse().slice(0, 2).join('/')}: chủ đề mới ${MARKET_NAMES[rp.market] || rp.market}`, desc: scanDesc(rp, true),
        from: rp.createdBy || a.owner, to: a.owner, agentId: a.id, pageId: null, researchId: rp.id, auto: true,
        status: 'moi', step: 0, returns: 0, outputs: [], history: [{ at, who: a.owner, text: `Lịch ${d.time || '08:30'} tự giao cho ${a.name}` }], createdAt: at, updatedAt: at
      };
      (rp.scans ||= []).push({ taskId: id, at, imported: false, auto: true });
      rp.agentId = a.id; rp.lastAuto = now.date;
      list.push(`${rp.market} → ${a.name}`);
    }
    return { save: list.length > 0, list };
  });
  for (const x of made.list) console.log(`Lịch sáng: đã giao quét ${x}`);
}

app.listen(Number(PORT), HOST, () => {
  console.log(`AUTOFB đang chạy: ${BASE_URL}`);
  if (FB_ENABLED) console.log(`Redirect URI cần khai báo trong app Meta: ${REDIRECT_URI}`);
  // Chạy ngay khi khởi động (bù nếu server bật sau giờ hẹn), rồi kiểm tra mỗi phút.
  const tick = () => dailyTick().catch(err => console.error('Lịch sáng lỗi:', err.message));
  tick(); setInterval(tick, 60 * 1000);
});
