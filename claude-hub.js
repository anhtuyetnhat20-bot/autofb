// Trung tâm Claude Code của AUTOFB: chat với Claude CLI ngay trong dashboard, chạy và quản lý các agent,
// kiểm tra máy (Node, Claude CLI, khóa trong .env), sao lưu và khôi phục dữ liệu khi chuyển máy.
//
// Chat: mỗi cuộc chat là một tiến trình `claude -p` chạy ở thư mục dự án, nói chuyện qua stream-json.
// Claude muốn sửa file hay chạy lệnh thì CLI gửi control_request can_use_tool; dashboard hiện nút
// Cho phép / Từ chối và server trả control_response. Đọc file trong dự án không cần hỏi.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ID_RE = /^[\w-]{1,80}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
// Chỉ nhận yêu cầu từ dashboard trên chính máy này: Host là localhost và có header riêng
// (trang web lạ không gửi được header này mà không qua preflight CORS, server không cho preflight).
function guard(req, res, next) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host) || req.get('x-autofb') !== '1') return res.status(403).json({ error: 'Chỉ dùng từ dashboard trên máy này' });
  next();
}

// ---------- Tìm Claude CLI ----------
let claudeBin = null;
export function resolveClaude() {
  if (claudeBin) return claudeBin;
  const pick = p => ({ cmd: p, shell: /\.(cmd|bat)$/i.test(p) });
  if (process.env.CLAUDE_BIN) return (claudeBin = pick(process.env.CLAUDE_BIN));
  if (process.platform === 'win32') {
    const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fss.existsSync(native)) return (claudeBin = pick(native));
    try {
      const list = execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const exe = list.find(p => /\.exe$/i.test(p)) || list.find(p => /\.(cmd|bat)$/i.test(p));
      if (exe) return (claudeBin = pick(exe));
    } catch {}
    return null;
  }
  try { execFileSync('which', ['claude'], { stdio: 'ignore' }); return (claudeBin = pick('claude')); } catch { return null; }
}
// Chạy Claude CLI. Với claude.cmd (cài qua npm trên Windows) phải chạy qua shell, nên mọi tham số
// phải là chữ an toàn; nội dung người dùng luôn đi qua stdin, không bao giờ qua tham số.
export function spawnClaude(args, cwd) {
  const bin = resolveClaude();
  if (!bin) throw new Error('Không tìm thấy Claude CLI. Cài Claude Code rồi chạy lại server (xem tab Máy này).');
  if (bin.shell) {
    const bad = args.find(a => !/^[\w.,:=\/\\-]+$/.test(a));
    if (bad) throw new Error('Tham số không an toàn: ' + bad);
  }
  return spawn(bin.shell ? `"${bin.cmd}"` : bin.cmd, args, { cwd, shell: bin.shell, windowsHide: true, env: { ...process.env } });
}
function killTree(p) {
  if (!p || p.exitCode != null) return;
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
  else p.kill('SIGTERM');
}
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `… (${s.length - n} ký tự nữa)` : s; };

export function mountClaude(app, { root, port, express }) {
  const DATA = path.join(root, 'data');
  const CHATS_FILE = path.join(DATA, 'claude-chats.json');
  const RUN_FILE = path.join(DATA, 'runners.json');

  // ================= Chat =================
  const chats = new Map(); // id -> chat
  const rel = p => { const r = path.relative(root, String(p || '')); return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : String(p || ''); };
  function saveChats() {
    const list = [...chats.values()].map(c => ({ id: c.id, title: c.title, sessionId: c.sessionId, createdAt: c.createdAt, updatedAt: c.updatedAt, cost: c.cost, autoAllow: [...c.autoAllow], events: c.events.slice(-300) }));
    fs.mkdir(DATA, { recursive: true }).then(() => fs.writeFile(CHATS_FILE, JSON.stringify(list, null, 1))).catch(() => {});
  }
  try {
    for (const c of JSON.parse(fss.readFileSync(CHATS_FILE, 'utf8')))
      chats.set(c.id, { ...c, events: c.events || [], autoAllow: new Set(c.autoAllow || []), proc: null, status: 'idle', pending: null });
  } catch {}
  const push = (c, ev) => { ev.at = Date.now(); ev.n = (c.events.at(-1)?.n ?? -1) + 1; c.events.push(ev); if (c.events.length > 600) c.events.splice(0, c.events.length - 600); c.updatedAt = ev.at; };

  // Tóm tắt một lời gọi công cụ để hiện trên dashboard.
  function toolView(name, input = {}) {
    const f = input.file_path || input.notebook_path || input.path;
    switch (name) {
      case 'Read': return { label: `Đọc ${rel(f)}` };
      case 'Write': return { label: `Tạo/ghi file ${rel(f)}`, file: rel(f), body: cut(input.content, 6000) };
      case 'Edit': return { label: `Sửa ${rel(f)}`, file: rel(f), old: cut(input.old_string, 4000), new: cut(input.new_string, 4000) };
      case 'MultiEdit': return { label: `Sửa ${rel(f)} (${(input.edits || []).length} chỗ)`, file: rel(f), edits: (input.edits || []).slice(0, 10).map(e => ({ old: cut(e.old_string, 1500), new: cut(e.new_string, 1500) })) };
      case 'Bash': case 'PowerShell': return { label: `Chạy lệnh`, cmd: cut(input.command, 2000), note: input.description || '' };
      case 'Grep': return { label: `Tìm “${cut(input.pattern, 80)}”${input.path ? ' trong ' + rel(input.path) : ''}` };
      case 'Glob': return { label: `Liệt kê file ${cut(input.pattern, 80)}` };
      case 'WebSearch': return { label: `Tìm trên web: ${cut(input.query, 120)}` };
      case 'WebFetch': return { label: `Đọc trang ${cut(input.url, 150)}` };
      case 'TodoWrite': return { label: 'Cập nhật danh sách việc', todos: (input.todos || []).slice(0, 20).map(t => ({ text: cut(t.content || t.activeForm, 160), status: t.status })) };
      default: return { label: name, body: cut(JSON.stringify(input, null, 1), 1500) };
    }
  }
  function handleLine(c, line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'system' && m.subtype === 'init') { c.sessionId = m.session_id || c.sessionId; c.model = m.model; return; }
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) push(c, { k: 'text', text: cut(b.text, 20000) });
        else if (b.type === 'tool_use') push(c, { k: 'tool', id: b.id, name: b.name, ...toolView(b.name, b.input) });
      }
      return;
    }
    if (m.type === 'user') {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b.type === 'tool_result') {
        const text = Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n') : b.content;
        const ev = c.events.findLast(e => e.k === 'tool' && e.id === b.tool_use_id);
        if (ev) { ev.done = true; ev.error = !!b.is_error; ev.out = cut(text, 3000); c.updatedAt = Date.now(); }
      }
      return;
    }
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const r = m.request, key = r.tool_name === 'Bash' ? 'Bash:' + r.input?.command : r.tool_name;
      if (c.autoAllow.has(key) || c.autoAllow.has(r.tool_name)) return respond(c, m.request_id, true, r.input);
      c.pending = { requestId: m.request_id, tool: r.tool_name, input: r.input, ...toolView(r.tool_name, r.input) };
      c.status = 'waiting'; push(c, { k: 'ask', requestId: m.request_id, name: r.tool_name, ...toolView(r.tool_name, r.input) });
      return;
    }
    if (m.type === 'control_request' && m.request?.subtype) {
      // Yêu cầu khác (hook, MCP…) chưa hỗ trợ: báo lỗi để CLI không chờ mãi.
      c.proc?.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'AUTOFB chưa hỗ trợ ' + m.request.subtype } }) + '\n');
      return;
    }
    if (m.type === 'result') {
      c.sessionId = m.session_id || c.sessionId;
      c.cost = (c.cost || 0) + (m.total_cost_usd || 0);
      push(c, { k: 'done', ok: !m.is_error && m.subtype === 'success', error: m.is_error ? cut(m.result || m.subtype, 2000) : '', ms: m.duration_ms, cost: m.total_cost_usd || 0 });
      c.status = 'idle'; c.pending = null; saveChats();
    }
  }
  function respond(c, requestId, allow, input, message) {
    const response = allow ? { behavior: 'allow', updatedInput: input || {} } : { behavior: 'deny', message: message || 'Người dùng từ chối.' };
    c.proc?.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
  }
  function startProc(c) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default'];
    if (c.sessionId && UUID_RE.test(c.sessionId)) args.push('--resume', c.sessionId);
    const p = spawnClaude(args, root);
    c.proc = p; let buf = '', err = '';
    p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handleLine(c, line); } });
    p.stderr.on('data', d => { err = (err + d).slice(-3000); });
    p.on('error', e => { push(c, { k: 'error', text: 'Không chạy được Claude CLI: ' + e.message }); c.status = 'idle'; c.proc = null; });
    p.on('exit', code => {
      if (c.proc === p) c.proc = null;
      if (c.status !== 'idle' || code) {
        const login = /log ?in|auth|credential|api key/i.test(err);
        push(c, { k: 'error', text: code ? `Claude CLI dừng (mã ${code}). ${login ? 'Có vẻ chưa đăng nhập: mở terminal, gõ claude rồi đăng nhập. ' : ''}${cut(err.trim(), 800)}` : 'Claude CLI đã dừng.' });
      }
      c.status = 'idle'; c.pending = null; saveChats();
    });
    clearTimeout(c.idleTimer);
    return p;
  }
  // Tiến trình rảnh 15 phút thì đóng; tin nhắn sau sẽ nối tiếp bằng --resume.
  function touchIdle(c) { clearTimeout(c.idleTimer); c.idleTimer = setTimeout(() => { if (c.status === 'idle' && c.proc) c.proc.stdin.end(); }, 15 * 60e3); }

  const view = (c, since = -1) => ({ id: c.id, title: c.title, status: c.status, running: !!c.proc, pending: c.pending, cost: c.cost || 0, model: c.model || null,
    sessionId: c.sessionId || null, events: c.events.filter(e => e.n > since), autoAllow: [...c.autoAllow], updatedAt: c.updatedAt });

  // Gắn trước express.json() chung của server, để file sao lưu lớn (tới 20 MB) vẫn nhận được.
  app.use(['/api/claude', '/api/run', '/api/system', '/api/backup'], guard, express.json({ limit: '20mb' }));
  app.get('/api/claude/chats', (req, res) => res.json([...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(c => ({ id: c.id, title: c.title, status: c.status, updatedAt: c.updatedAt, cost: c.cost || 0, pending: !!c.pending }))));
  app.post('/api/claude/chats', (req, res) => {
    const c = { id: 'cc_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), title: cut(req.body?.title || 'Cuộc chat mới', 80), sessionId: null, events: [], autoAllow: new Set(), proc: null, status: 'idle', pending: null, createdAt: Date.now(), updatedAt: Date.now(), cost: 0 };
    chats.set(c.id, c); saveChats(); res.json(view(c));
  });
  const getChat = (req, res) => { const c = ID_RE.test(req.params.id) && chats.get(req.params.id); if (!c) res.status(404).json({ error: 'Không có cuộc chat này' }); return c; };
  app.get('/api/claude/chats/:id', (req, res) => { const c = getChat(req, res); if (c) res.json(view(c, req.query.since == null ? -1 : +req.query.since)); });
  // Tin nhắn có thể kèm tệp: { text, files:[{ name, type, data(base64) }] }. Ảnh gửi thẳng cho Claude (khối image) và lưu ở data/media
  // để hiện lại trong chat; tệp khác lưu ở data/claude/uploads/<chat>/ rồi báo đường dẫn để Claude đọc bằng công cụ Read.
  const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  app.post('/api/claude/chats/:id/message', async (req, res) => {
    const c = getChat(req, res); if (!c) return;
    const text = String(req.body?.text || '').trim();
    const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 8) : [];
    if (!text && !files.length) return res.status(400).json({ error: 'Tin nhắn trống' });
    if (c.status !== 'idle') return res.status(409).json({ error: 'Claude đang làm, chờ xong hoặc bấm Dừng' });
    const blocks = [], shown = [], paths = [];
    try {
      for (const [i, f] of files.entries()) {
        const type = String(f?.type || ''), name = (path.basename(String(f?.name || 'tep')).replace(/[^\w.\- ()]/g, '_').slice(0, 80)) || 'tep';
        const buf = Buffer.from(String(f?.data || ''), 'base64');
        if (!buf.length) continue;
        const ext = IMG_TYPES[type];
        if (ext && buf.length <= 5 * 1024 * 1024) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } });
          const fn = `chat-${c.id}-${Date.now().toString(36)}${i}.${ext}`;
          await fs.mkdir(path.join(DATA, 'media'), { recursive: true }); await fs.writeFile(path.join(DATA, 'media', fn), buf);
          shown.push({ name, url: '/media/' + fn });
        } else {
          if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: `${name} lớn quá (tối đa 10 MB)` });
          const dir = path.join(DATA, 'claude', 'uploads', c.id); await fs.mkdir(dir, { recursive: true });
          const fp = path.join(dir, `${Date.now().toString(36)}-${name}`); await fs.writeFile(fp, buf);
          paths.push(rel(fp)); shown.push({ name });
        }
      }
    } catch (e) { return res.status(500).json({ error: 'Không lưu được tệp: ' + e.message }); }
    try { if (!c.proc) startProc(c); } catch (e) { return res.status(500).json({ error: e.message }); }
    if (!c.events.length && c.title === 'Cuộc chat mới') c.title = cut((text || shown.map(f => f.name).join(', ')).replace(/\s+/g, ' '), 60);
    push(c, { k: 'user', text: cut(text, 20000), files: shown });
    c.status = 'running';
    const note = paths.length ? `\n\n[Tệp đính kèm, đọc bằng công cụ Read: ${paths.join(', ')}]` : '';
    const body = (text || (blocks.length ? 'Xem ảnh đính kèm.' : 'Xem tệp đính kèm.')) + note;
    const content = blocks.length ? [...blocks, { type: 'text', text: body }] : body;
    c.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: c.sessionId || '' }) + '\n');
    touchIdle(c); saveChats(); res.json(view(c));
  });
  app.post('/api/claude/chats/:id/permission', (req, res) => {
    const c = getChat(req, res); if (!c) return;
    const p = c.pending;
    if (!p || p.requestId !== req.body?.requestId) return res.status(409).json({ error: 'Không có yêu cầu quyền nào đang chờ' });
    const allow = !!req.body.allow;
    // “Luôn cho phép trong chat này”: sửa/tạo file theo tên công cụ; lệnh thì chỉ đúng lệnh đó.
    if (allow && req.body.always) c.autoAllow.add(p.tool === 'Bash' ? 'Bash:' + p.input?.command : p.tool);
    respond(c, p.requestId, allow, p.input, cut(req.body.message, 500) || undefined);
    const ev = c.events.findLast(e => e.k === 'ask' && e.requestId === p.requestId);
    if (ev) ev.answer = allow ? (req.body.always ? 'always' : 'allow') : 'deny';
    c.pending = null; c.status = 'running'; c.updatedAt = Date.now(); saveChats();
    res.json(view(c));
  });
  app.post('/api/claude/chats/:id/stop', (req, res) => {
    const c = getChat(req, res); if (!c) return;
    killTree(c.proc); c.proc = null; c.status = 'idle'; c.pending = null;
    push(c, { k: 'error', text: 'Bạn đã dừng Claude.' }); saveChats(); res.json(view(c));
  });
  app.delete('/api/claude/chats/:id', (req, res) => {
    const c = getChat(req, res); if (!c) return;
    killTree(c.proc); chats.delete(c.id); saveChats(); res.json({ ok: true });
  });

  // ================= Chạy agent =================
  const node = process.execPath;
  const envArgs = () => fss.existsSync(path.join(root, '.env')) ? ['--env-file=.env'] : [];
  const RUNNERS = {
    research: { label: 'Agent research', engine: 'API Anthropic', args: ['agents/research.js'] },
    leader: { label: 'Agent Leader', engine: 'API Anthropic', args: ['agents/research.js', '--leader'] },
    designer: { label: 'Agent designer', engine: 'API OpenAI (ảnh)', args: ['agents/designer.js'] },
    'cli-research': { label: 'Agent research', engine: 'Claude CLI', args: ['agents/cli-runner.js', '--role', 'research'] },
    'cli-leader': { label: 'Agent Leader', engine: 'Claude CLI', args: ['agents/cli-runner.js', '--role', 'leader'] },
    'cli-noidung': { label: 'Agent Content', engine: 'Claude CLI', args: ['agents/cli-runner.js', '--role', 'noidung'] },
    'cli-designer': { label: 'Agent designer', engine: 'Claude CLI (vẽ SVG)', args: ['agents/cli-runner.js', '--role', 'designer'] },
    'cli-editor': { label: 'Agent editor', engine: 'Claude CLI', args: ['agents/cli-runner.js', '--role', 'editor'] },
    'cli-congdong': { label: 'Agent Community', engine: 'Claude CLI', args: ['agents/cli-runner.js', '--role', 'congdong'] }
  };
  const runs = {}; // key -> { proc, startedAt, log: [{n,at,text}], exit }
  let runCfg = { autostart: [] };
  try { runCfg = { autostart: [], ...JSON.parse(fss.readFileSync(RUN_FILE, 'utf8')) }; } catch {}
  const saveRunCfg = () => fs.mkdir(DATA, { recursive: true }).then(() => fs.writeFile(RUN_FILE, JSON.stringify(runCfg, null, 2))).catch(() => {});
  function runLog(key, text) {
    const r = runs[key] ||= { log: [] };
    for (const line of String(text).split(/\r?\n/)) if (line.trim()) { r.log.push({ n: (r.log.at(-1)?.n ?? -1) + 1, at: Date.now(), text: cut(line, 2000) }); }
    if (r.log.length > 800) r.log.splice(0, r.log.length - 800);
  }
  function startRun(key) {
    const R = RUNNERS[key]; const r = runs[key] ||= { log: [] };
    if (r.proc) return;
    // Hai bản của cùng một agent (API và CLI) không chạy cùng lúc, tránh tranh task.
    const twin = Object.keys(RUNNERS).find(k => k !== key && runs[k]?.proc && RUNNERS[k].label === R.label);
    if (twin) throw new Error(`${R.label} đang chạy bằng ${RUNNERS[twin].engine}. Dừng bản đó trước.`);
    const p = spawn(node, [...envArgs(), ...R.args], { cwd: root, windowsHide: true, env: { ...process.env, AUTOFB_URL: `http://localhost:${port}` } });
    r.proc = p; r.startedAt = Date.now(); r.exit = null;
    runLog(key, `--- Bật ${R.label} (${R.engine}) ---`);
    p.stdout.on('data', d => runLog(key, d)); p.stderr.on('data', d => runLog(key, d));
    p.on('exit', code => { r.proc = null; r.exit = code; runLog(key, `--- Đã dừng${code ? ' (mã ' + code + ')' : ''} ---`); });
    p.on('error', e => { r.proc = null; runLog(key, 'Không chạy được: ' + e.message); });
  }
  const runView = (key, since = -1) => { const R = RUNNERS[key], r = runs[key] || { log: [] };
    return { key, label: R.label, engine: R.engine, running: !!r.proc, startedAt: r.proc ? r.startedAt : null, exit: r.exit ?? null, auto: runCfg.autostart.includes(key), log: r.log.filter(l => l.n > since).slice(-300) }; };
  app.get('/api/run', (req, res) => res.json(Object.keys(RUNNERS).map(k => ({ ...runView(k), log: (runs[k]?.log || []).slice(-3) }))));
  app.get('/api/run/:key', (req, res) => { if (!RUNNERS[req.params.key]) return res.status(404).end(); res.json(runView(req.params.key, req.query.since == null ? -1 : +req.query.since)); });
  app.post('/api/run/:key/:act', (req, res) => {
    const key = req.params.key; if (!RUNNERS[key]) return res.status(404).json({ error: 'Không có chương trình này' });
    try {
      if (req.params.act === 'start') { runCfg.off = (runCfg.off || []).filter(k => k !== key); saveRunCfg(); startRun(key); }
      else if (req.params.act === 'stop') { killTree(runs[key]?.proc); if (key.startsWith('cli-')) { runCfg.off = [...new Set([...(runCfg.off || []), key])]; saveRunCfg(); } }
      else if (req.params.act === 'auto') { runCfg.autostart = req.body?.on ? [...new Set([...runCfg.autostart, key])] : runCfg.autostart.filter(k => k !== key); saveRunCfg(); }
      else return res.status(400).json({ error: 'Lệnh không hợp lệ' });
    } catch (e) { return res.status(409).json({ error: e.message }); }
    setTimeout(() => res.json(runView(key)), 300);
  });
  // Bật các agent đã đánh dấu “tự bật cùng server”.
  setTimeout(() => runCfg.autostart.forEach(k => { try { if (RUNNERS[k]) startRun(k); } catch (e) { runLog(k, e.message); } }), 1500);
  const stopAll = () => { Object.values(runs).forEach(r => killTree(r.proc)); chats.forEach(c => killTree(c.proc)); };
  process.on('exit', stopAll);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); process.exit(0); });

  // ================= Máy này =================
  const ENV_KEYS = ['FB_APP_ID', 'FB_APP_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'REDDIT_CLIENT_ID', 'YOUTUBE_API_KEY'];
  app.get('/api/system', async (req, res) => {
    const bin = resolveClaude();
    let version = null;
    if (bin) { try { version = execFileSync(bin.shell ? 'cmd' : bin.cmd, bin.shell ? ['/c', bin.cmd, '--version'] : ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim(); } catch {} }
    const size = async f => { try { return (await fs.stat(path.join(DATA, f))).size; } catch { return null; } };
    let media = 0; try { media = (await fs.readdir(path.join(DATA, 'media'))).length; } catch {}
    res.json({ node: process.version, nodeOk: +process.versions.node.split('.')[0] >= 20, platform: `${os.type()} ${os.release()}`, host: os.hostname(), root,
      claude: { found: !!bin, path: bin?.cmd || null, version }, envFile: fss.existsSync(path.join(root, '.env')),
      env: Object.fromEntries(ENV_KEYS.map(k => [k, !!process.env[k]])),
      data: { workspace: await size('workspace.json'), store: await size('store.json'), chats: await size('claude-chats.json'), media } });
  });
  // Thử Claude CLI bằng một câu rất ngắn để biết đã đăng nhập chưa.
  app.post('/api/system/claude-test', (req, res) => {
    let p; try { p = spawnClaude(['-p', '--output-format', 'json', '--permission-prompts', 'none'], root); } catch (e) { return res.json({ ok: false, error: e.message }); }
    let out = '', err = ''; const timer = setTimeout(() => killTree(p), 90e3);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('exit', code => { clearTimeout(timer);
      let j = null; try { j = JSON.parse(out); } catch {}
      if (j && !j.is_error) return res.json({ ok: true, text: cut(j.result, 200), cost: j.total_cost_usd || 0 });
      res.json({ ok: false, error: cut((j?.result || err || out || `mã ${code}`).trim(), 600) }); });
    p.on('error', e => { clearTimeout(timer); res.json({ ok: false, error: e.message }); });
    p.stdin.end('Trả lời đúng một chữ: OK');
  });
  // Sao lưu dữ liệu làm việc (không gồm store.json vì chứa token Facebook).
  app.get('/api/backup', async (req, res) => {
    const read = async f => { try { return JSON.parse(await fs.readFile(path.join(DATA, f), 'utf8')); } catch { return null; } };
    res.setHeader('Content-Disposition', `attachment; filename="autofb-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ app: 'autofb', version: 1, at: Date.now(), from: os.hostname(), workspace: await read('workspace.json'), claudeChats: await read('claude-chats.json'), runners: await read('runners.json') });
  });
  // Server gọi khi vừa giao việc cho một agent: agent chưa chạy (cả bản API lẫn CLI) thì tự bật bản Claude CLI.
  const wake = role => { const key = 'cli-' + role, R = RUNNERS[key]; if (!R || (runCfg.off || []).includes(key)) return;
    if (Object.keys(RUNNERS).some(k => runs[k]?.proc && RUNNERS[k].label === R.label)) return;
    try { startRun(key); runLog(key, '(Tự bật vì có việc mới được giao)'); } catch {} };
  app.post('/api/backup/restore', async (req, res) => {
    const b = req.body;
    if (b?.app !== 'autofb' || !b.workspace || typeof b.workspace !== 'object') return res.status(400).json({ error: 'File sao lưu không hợp lệ' });
    await fs.mkdir(DATA, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { await fs.copyFile(path.join(DATA, 'workspace.json'), path.join(DATA, `workspace.before-restore-${stamp}.json`)); } catch {}
    await fs.writeFile(path.join(DATA, 'workspace.json'), JSON.stringify(b.workspace, null, 2));
    if (b.runners) await fs.writeFile(RUN_FILE, JSON.stringify(b.runners, null, 2));
    res.json({ ok: true });
  });
  return { wake };
}
