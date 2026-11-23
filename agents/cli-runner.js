// Chạy một agent AUTOFB bằng Claude CLI (Claude Code) thay cho API key: dùng gói Claude đang đăng nhập trên máy.
// Vòng lặp giống agents/research.js: hỏi server có task (GET /api/agents/<id>/next) → gọi `claude -p` với gói ngữ cảnh
// → kiểm tra JSON → nộp (POST /api/tasks/<id>/result). Lỗi thì trả task về (POST /api/tasks/<id>/release).
//
// Chạy:  node --env-file=.env agents/cli-runner.js --role research   (research, leader, noidung, congdong, designer…)
//        thêm --once để hỏi một lần rồi thoát. Thường bật từ tab Claude Code > Agent đang chạy.
//
// Claude CLI chạy trong thư mục riêng data/claude/runner (không thấy code, .env hay dữ liệu của dự án),
// chỉ được tìm và đọc web; không chạy lệnh, không sửa file; không đọc Facebook, Instagram, Threads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClaude } from '../claude-hub.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROLE = arg('--role') || 'research';
const ONCE = process.argv.includes('--once');
const { AUTOFB_URL = 'http://localhost:3000', POLL_SECONDS = '60', CLI_MODEL = '' } = process.env;
const AGENT_ID = process.env[`${ROLE.toUpperCase()}_AGENT_ID`] || process.env.CLI_AGENT_ID || '';
const ROLE_NAME = { research: 'Agent research', leader: 'Agent Leader', noidung: 'Agent Content', designer: 'Agent designer', editor: 'Agent editor', congdong: 'Agent Community' }[ROLE] || 'Agent ' + ROLE;
const WORK = path.join(ROOT, 'data', 'claude', 'runner');
const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, o = {}) => fetch(AUTOFB_URL + p, { ...o, headers: { 'Content-Type': 'application/json', ...o.headers } });

// Quyền của Claude CLI khi chạy agent: chỉ tìm và đọc web.
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'settings.json'), JSON.stringify({
  permissions: {
    allow: ['WebSearch', 'WebFetch'],
    deny: ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch(domain:facebook.com)', 'WebFetch(domain:www.facebook.com)', 'WebFetch(domain:instagram.com)', 'WebFetch(domain:www.instagram.com)', 'WebFetch(domain:threads.net)']
  }
}, null, 2));

async function resolveAgentId() {
  if (AGENT_ID) return AGENT_ID;
  const ws = await (await api('/api/ws')).json();
  const list = ws.agents.filter(a => (a.role || a.template) === ROLE);
  if (list.length === 1) return list[0].id;
  if (!list.length) throw new Error(`Chưa có ${ROLE_NAME} trong hệ thống. Tạo ở trang Tổ chức agent rồi bật lại.`);
  throw new Error(`Có nhiều ${ROLE_NAME}. Ghi ${ROLE.toUpperCase()}_AGENT_ID vào .env, chọn một trong: ` + list.map(a => `${a.id} (${a.name})`).join(', '));
}

function buildPrompt(p) {
  const a = p.agent, t = p.task;
  const list = (title, items) => items?.length ? `\n## ${title}\n${items.map(x => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')}\n` : '';
  const brain = p.brain ? Object.entries({ 'kien-thuc': 'Kiến thức', mau: 'Mẫu hay', 'lien-ket': 'Tài liệu tham khảo', 'tong-ket': 'Việc bạn đã làm gần đây (tự tổng kết)' })
    .map(([k, h]) => list(h, (p.brain[k] || []).map(x => `${x.title ? x.title + ': ' : ''}${x.text}${x.url ? ` (${x.url})` : ''}`))).join('') : '';
  return [
    `# Vai trò\n${a.prompt || `Bạn là ${a.name}${a.role ? ` (${a.role})` : ''}. ${a.mission}`}`,
    a.reportsTo ? `Bạn báo cáo cho ${a.reportsTo}.` : '',
    list('Luật chung của hệ thống (bắt buộc)', a.globalRules), list('Luật riêng', a.rules), list('Định nghĩa xong', a.definitionOfDone),
    `\n## Trả về gì\n${a.output || 'Một JSON.'}`,
    list('Bài học và phản hồi trong Second Brain (áp dụng tất cả)', p.lessons), brain,
    p.goals ? list('Mục tiêu của đội', p.goals.map(g => `${g.title}: ${g.current}/${g.target} ${g.unit || ''}${g.due ? ', hạn ' + g.due : ''}`)) : '',
    `\n# Task: ${t.title}\nBước hiện tại: ${t.step.index + 1}. “${t.step.name}”. Chỉ làm bước này.\nHôm nay: ${new Date().toISOString().slice(0, 10)}.\n\n## Mô tả task\n${t.desc || '(trống)'}`,
    t.payload ? `\n## Dữ liệu kèm task\n${JSON.stringify(t.payload, null, 2)}` : '',
    t.returnNotes?.length ? list('Lý do lần trước bị trả lại (sửa đúng các điểm này trước)', t.returnNotes) : '',
    t.pagePlan ? `\n## Kế hoạch nội dung đã duyệt của page (bám theo: đúng pillar, giọng, mục tiêu)\n${Object.entries(t.pagePlan).map(([k, v]) => `### ${k}\n${v}`).join('\n\n')}` : '',
    t.previousOutputs?.length ? `\n## Kết quả các bước trước\n${t.previousOutputs.map(o => `### ${o.step}\n${o.text}`).join('\n\n')}` : '',
    `\n# Môi trường\nBạn chỉ có công cụ tìm kiếm web (WebSearch) và đọc trang web (WebFetch). Không đọc Facebook, Instagram, Threads (bị chặn); ở bước kiểm tra tên thì được xem kết quả tìm kiếm có các trang đó. Không bịa số liệu hay đường link: link phải lấy từ kết quả tìm kiếm.\nTrả lời cuối cùng chỉ gồm đúng một JSON, không thêm chữ nào ngoài JSON, không bọc trong \`\`\`.\nThêm vào JSON khóa \`_brain\` để tự tổng kết vào Second Brain của bạn: { "tom_tat": "1–2 câu: bạn đã làm gì, kết quả chính", "bai_hoc": ["tối đa 3 điều rút ra để lần sau làm tốt hơn"], "mau": ["cách làm hay đáng giữ, nếu có"], "kien_thuc": ["hiểu biết mới về ngách, khán giả, nếu có"] }. Không lặp lại bài học đã có trong Second Brain.`
  ].filter(Boolean).join('\n');
}
function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('không thấy JSON');
  return JSON.parse(t.slice(a, b + 1));
}
// Kiểm tra tối thiểu theo bước, giống agents/research.js.
const isSvg = s => typeof s === 'string' && /^\s*<svg[\s>]/i.test(s) && /<\/svg>\s*$/i.test(s) && !/<script|<foreignObject|\son\w+\s*=|href\s*=\s*["']https?:/i.test(s);
function check(d, step, payload) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'kết quả phải là một object JSON';
  const n = step.name || '';
  if (payload?.images) {
    if (!Array.isArray(d.images) || d.images.length < payload.images.length) return `cần mảng \`images\` đủ ${payload.images.length} hình`;
    if (d.images.some(x => !isSvg(x?.svg))) return 'mỗi hình cần `svg` là một SVG hoàn chỉnh, không script, không link ra ngoài';
    return null;
  }
  if (/^Ý tưởng/i.test(n) && !Array.isArray(d.ideas)) return 'bước “Ý tưởng” cần mảng `ideas`';
  if (/^Bài hoàn chỉnh/i.test(n)) { if (!/^(Video Reel|Carousel|Ảnh đơn|Bài chữ \/ Câu hỏi)$/.test(d.post_type || '')) return '`post_type` phải là “Video Reel”, “Carousel”, “Ảnh đơn” hoặc “Bài chữ / Câu hỏi”';
    if (typeof d.caption !== 'string' || d.caption.trim().split(/\s+/).length < 25) return 'cần `caption` hoàn chỉnh (ít nhất 25 từ)';
    const v = d.visual || {}; if (d.post_type === 'Video Reel' && (!Array.isArray(v.shots) || v.shots.length < 3)) return 'Video Reel cần `visual.shots` (ít nhất 3 cảnh, mỗi cảnh có shot, voiceover, on_screen)';
    if (d.post_type === 'Carousel' && (!Array.isArray(v.slides) || v.slides.length < 4)) return 'Carousel cần `visual.slides` (ít nhất 4 slide)';
    if (/Ảnh đơn|Bài chữ/.test(d.post_type) && !v.image) return 'cần `visual.image` mô tả hình';
    if (!Array.isArray(d.needs_real_data)) return 'cần `needs_real_data` (mảng, rỗng nếu không có)'; }
  if (/Kịch bản/i.test(n) && (!Array.isArray(d.hooks) || !Array.isArray(d.scenes))) return 'bước “Kịch bản và hook” cần `hooks` và `scenes`';
  if (/^Caption/i.test(n) && typeof d.caption !== 'string') return 'bước “Caption” cần chuỗi `caption`';
  if (/Phác ý tưởng hình/i.test(n) && !Array.isArray(d.assets)) return 'bước “Phác ý tưởng hình” cần mảng `assets`';
  if (/^Thiết kế/i.test(n) && (!Array.isArray(d.assets) || d.assets.some(x => !isSvg(x?.svg)))) return 'bước “Thiết kế” cần `assets`, mỗi mục có `svg` hoàn chỉnh, không script, không link ra ngoài';
  if (/Dựng bản nháp|Bản hoàn chỉnh/i.test(n) && !Array.isArray(d.timeline)) return 'bước dựng cần mảng `timeline`';
  if (/Chấm bài/i.test(n) && typeof d.pass !== 'boolean') return 'bước “Chấm bài” cần `pass` là true hoặc false';
  if (/Chấm bài/i.test(n) && (!Array.isArray(d.checklist) || d.checklist.length < 8)) return 'bước “Chấm bài” cần `checklist` đủ 8 nhóm';
  if (/Phân loại|Soạn trả lời/i.test(n) && !Array.isArray(d.items)) return 'bước này cần mảng `items`';
  if (/Quét nguồn/i.test(n) && !Array.isArray(d.findings)) return 'bước “Quét nguồn” cần mảng `findings`';
  if (/^Chiến lược nội dung/i.test(n)) { const st = d.strategy; if (!st || typeof st !== 'object') return 'bước “Chiến lược nội dung” cần object `strategy`';
    for (const k of ['goals', 'personas', 'funnel', 'cadence', 'kpis']) if (!Array.isArray(st[k]) || !st[k].length) return `\`strategy.${k}\` phải là mảng có nội dung`;
    if (!st.mission || !st.voice) return 'cần `strategy.mission` và `strategy.voice`'; }
  if (/^Content pillar/i.test(n)) { if (!Array.isArray(d.pillars) || d.pillars.length < 3 || d.pillars.length > 5) return 'bước “Content pillar” cần 3–5 mục trong `pillars`';
    if (d.pillars.some(p => !p.name || !Array.isArray(p.subtopics) || p.subtopics.length < 4)) return 'mỗi pillar cần `name` và ít nhất 4 `subtopics`';
    const tot = d.pillars.reduce((s, p) => s + (+p.share_pct || 0), 0); if (Math.abs(tot - 100) > 2) return `tổng \`share_pct\` các pillar phải bằng 100 (đang là ${tot})`; }
  if (/^Content calendar/i.test(n)) { const c = d.calendar; if (!c || !Array.isArray(c.weeks) || !c.weeks.length) return 'bước “Content calendar” cần mảng `calendar.weeks` (4 tuần cho kế hoạch, 1 tuần cho lịch tuần)';
    if (c.weeks.some(w => !Array.isArray(w.posts) || !w.posts.length)) return 'mỗi tuần cần mảng `posts`';
    if (c.weeks.some(w => w.posts.some(p => !p.date || !p.pillar || !p.hook))) return 'mỗi bài trong lịch cần `date`, `pillar`, `hook`'; }
  if (/Tổng hợp chủ đề/i.test(n)) {
    if (!Array.isArray(d.topics)) return 'bước “Tổng hợp chủ đề” cần mảng `topics`';
    const i = d.topics.findIndex(t => !t?.title || ['demand', 'growth', 'engagement', 'competition', 'monetization'].some(k => !Number.isInteger(t[k]) || t[k] < 1 || t[k] > 5));
    if (i >= 0) return `chủ đề thứ ${i + 1} thiếu title hoặc có điểm không phải số nguyên 1–5`;
  }
  if (/Đề xuất kênh/i.test(n)) {
    if (!Array.isArray(d.channels)) return 'bước “Đề xuất kênh” cần mảng `channels`';
    const i = d.channels.findIndex(c => !c?.name || !c.positioning || !Array.isArray(c.pillars) || !Array.isArray(c.videos) || !Array.isArray(c.topics));
    if (i >= 0) return `kênh thứ ${i + 1} thiếu name, positioning, pillars, videos hoặc topics`;
  }
  if (/Kiểm duyệt tên/i.test(n)) {
    if (!Array.isArray(d.checks)) return 'bước “Kiểm duyệt tên kênh” cần mảng `checks`';
    if (d.checks.some(c => !c?.channel || !Array.isArray(c.names) || c.names.some(x => !['trong', 'gan-giong', 'trung'].includes(x?.result)))) return 'mỗi mục checks cần channel và names với result là trong, gan-giong hoặc trung';
  }
  return null;
}
// Một lần gọi Claude CLI. Nội dung đi qua stdin.
function runClaude(input, resume) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--permission-prompts', 'none', '--settings', 'settings.json'];
    const model = process.env[`${String(ROLE || '').toUpperCase()}_MODEL`] || CLI_MODEL || 'sonnet';
    if (/^[\w.-]+$/.test(model)) args.push('--model', model);
    if (resume && /^[0-9a-f-]{36}$/i.test(resume)) args.push('--resume', resume);
    let p; try { p = spawnClaude(args, WORK); } catch (e) { return reject(e); }
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('Claude CLI chạy quá 25 phút')); }, 25 * 60e3);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err = (err + d).slice(-2000));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('exit', code => {
      clearTimeout(timer);
      let j; try { j = JSON.parse(out); } catch { return reject(new Error(`Claude CLI không trả kết quả (mã ${code}). ${/log ?in|auth/i.test(err + out) ? 'Có vẻ chưa đăng nhập: chạy claude trong terminal để đăng nhập. ' : ''}${(err || out).trim().slice(0, 400)}`)); }
      if (j.is_error) return reject(new Error('Claude CLI báo lỗi: ' + String(j.result || j.subtype).slice(0, 400)));
      resolve(j);
    });
    p.stdin.end(input);
  });
}

// ----- Muse (muse2api) cho việc đơn giản -----
const MUSE_KEY = String(process.env.MUSE2API_KEY || process.env.MUSE_API_KEY || '').trim();
const MUSE_BASE = String(process.env.MUSE2API_BASE || process.env.MUSE_BASE || process.env.MUSE_API_BASE || (MUSE_KEY ? 'http://127.0.0.1:18610' : '')).trim().replace(/\/+$/, '');
const MUSE_MODEL = process.env.MUSE_MODEL || 'muse-spark';
const MUSE_TEXT = MUSE_KEY && process.env.MUSE_TEXT !== '0';
const chuLuc = p => p.pageTier ? p.pageTier === 'chu-luc' : (/apartment dog|dog life|remember when|80s\/90s/i.test(p.task.page || '') || /Series chủ lực/.test(p.task.desc || ''));
// Việc giao Muse: không cần tìm web, ít ảnh hưởng chất lượng page chủ lực.
function museSimple(p) {
  const n = p.task.step.name || '', r = ROLE;
  if (r === 'congdong') return true;
  if (r === 'noidung') return /^(Ý tưởng|Caption)/i.test(n) || /^Caption bài đầu tiên/i.test(p.task.title || '') || (/^Bài hoàn chỉnh/i.test(n) && !chuLuc(p));
  if (r === 'leader') return /Phân tích số liệu/i.test(n) || (/Chấm bài/i.test(n) && !chuLuc(p));
  if (r === 'research') return /Tổng hợp chủ đề/i.test(n);
  return false;
}
async function museChat(messages) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 6 * 60e3);
  try {
    const r = await fetch(MUSE_BASE + '/v1/chat/completions', { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${MUSE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MUSE_MODEL, messages }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Muse: ' + (j.error?.message || j.error || r.status));
    const c = j.choices?.[0]?.message?.content; if (!c) throw new Error('Muse không trả nội dung');
    return typeof c === 'string' ? c : c.map(x => x.text || '').join('');
  } finally { clearTimeout(tm); }
}
async function runMuse(p, report) {
  report({ phase: `Muse: ${p.task.step.name}`, text: 'Muse đang làm (tiết kiệm Claude)' });
  const prompt = buildPrompt(p).replace(/\n# Môi trường\n[^\n]*\n/, '\n# Môi trường\nBạn không có công cụ tìm hay đọc web. Chỉ dùng thông tin trong đề bài, Second Brain và kết quả các bước trước. Không bịa số liệu hay đường link.\n');
  const msgs = [{ role: 'user', content: prompt }];
  let txt = await museChat(msgs);
  for (let i = 0; ; i++) {
    let data, problem;
    try { data = extractJson(txt); problem = check(data, p.task.step, p.task.payload); } catch (e) { problem = 'JSON không hợp lệ: ' + e.message; }
    if (!problem) { log('  Muse làm xong.'); return data; }
    if (i >= 1) throw new Error('Muse trả kết quả chưa dùng được: ' + problem);
    report({ phase: 'Muse đang sửa định dạng', text: problem });
    msgs.push({ role: 'assistant', content: txt }, { role: 'user', content: `Kết quả chưa dùng được: ${problem}. Trả lại đúng một JSON theo định dạng của bước “${p.task.step.name}”, không thêm chữ nào ngoài JSON.` });
    txt = await museChat(msgs);
  }
}
async function runTask(p, report) {
  if (MUSE_TEXT && (museSimple(p) || p.claudeLimited)) {
    try { return await runMuse(p, report); }
    catch (e) { log('  Muse chưa làm được:', e.message); if (p.claudeLimited) throw new Error('Muse lỗi trong lúc Claude hết hạn mức: ' + e.message); log('  Chuyển sang Claude.'); }
  }
  return runClaudeTask(p, report);
}
async function runClaudeTask(p, report) {
  report({ phase: `Claude CLI: ${p.task.step.name}`, text: 'Đang làm' });
  let r = await runClaude(buildPrompt(p));
  let cost = r.total_cost_usd || 0;
  for (let i = 0; ; i++) {
    let data, problem;
    try { data = extractJson(r.result); problem = check(data, p.task.step, p.task.payload); } catch (e) { problem = 'JSON không hợp lệ: ' + e.message; }
    if (!problem) { log(`  Xong${cost ? `, chi phí ước tính $${cost.toFixed(3)}` : ''}.`); return data; }
    if (i >= 1) throw new Error('Kết quả không dùng được: ' + problem);
    log('  Kết quả chưa đúng định dạng (' + problem + '), nhờ Claude sửa…');
    report({ phase: 'Đang sửa định dạng kết quả', text: problem });
    r = await runClaude(`Kết quả chưa dùng được: ${problem}. Trả lại đúng một JSON theo định dạng của bước “${p.task.step.name}”, không thêm chữ nào ngoài JSON.`, r.session_id);
    cost += r.total_cost_usd || 0;
  }
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
async function main() {
  const agentId = await resolveAgentId();
  log(`${ROLE_NAME} ${agentId} chạy bằng Claude CLI, đang chờ việc từ ${AUTOFB_URL}${CLI_MODEL ? ` (model ${CLI_MODEL})` : ''}.`);
  for (;;) {
    let res;
    try { res = await api(`/api/agents/${agentId}/next`); } catch (e) { log('Không gọi được server AUTOFB:', e.message); res = null; }
    if (res?.status === 200) {
      const p = await res.json();
      log(`Nhận task “${p.task.title}”, bước ${p.task.step.index + 1} “${p.task.step.name}”.`);
      const s = { phase: '', text: '', searches: 0, fetches: 0 };
      const send = () => api(`/api/tasks/${p.task.id}/progress`, { method: 'POST', body: JSON.stringify(s) }).catch(() => {});
      const beat = setInterval(send, 20000);
      try {
        const data = await runTask(p, patch => { Object.assign(s, patch); send(); });
        clearInterval(beat);
        const r = await api(`/api/tasks/${p.task.id}/result`, { method: 'POST', body: JSON.stringify({ output: JSON.stringify(data, null, 2) }) });
        const j = await r.json();
        if (!r.ok) throw new Error('Server từ chối kết quả: ' + (j.error || r.status));
        log(`Đã nộp. Task giờ ở trạng thái: ${j.status}.`);
        continue;
      } catch (e) {
        clearInterval(beat);
        const lim = limitUntil(e.message);
        log(lim ? `Hết hạn mức gói Claude, trả task về và nghỉ đến ${new Date(lim).toLocaleTimeString('vi-VN')}.` : 'Lỗi, trả task về server:', lim ? '' : e.message);
        await api(`/api/tasks/${p.task.id}/release`, { method: 'POST', body: JSON.stringify({ reason: String(e.message).slice(0, 500), limit: lim || undefined }) }).catch(() => {});
        if (lim) { await sleep(MUSE_TEXT && ROLE !== 'designer' ? 60e3 : Math.max(60e3, lim - Date.now())); continue; }
      }
    } else if (res?.status === 423) log('Đang dừng khẩn, chờ…');
    else if (res?.status === 429) { const j = await res.json().catch(() => ({})); const until = +j.until || Date.now() + 30 * 60e3; log(`Gói Claude đang hết hạn mức, nghỉ đến ${new Date(until).toLocaleTimeString('vi-VN')}.`); await sleep(Math.max(60e3, until - Date.now())); continue; }
    if (ONCE) break;
    await sleep(+POLL_SECONDS * 1000);
  }
}
main().catch(e => { log(e.message); process.exit(1); });
