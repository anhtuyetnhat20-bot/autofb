// Chương trình chạy agent research trên máy người phụ trách.
// Vòng lặp: hỏi server AUTOFB có task không (GET /api/agents/<id>/next) → gọi Claude với prompt, luật,
// bài học và task trong gói ngữ cảnh, cho phép tìm và đọc web → kiểm tra JSON → nộp (POST /api/tasks/<id>/result).
// Lỗi thì trả task về server (POST /api/tasks/<id>/release); lỗi 3 lần server khóa task chờ người xem.
//
// Chạy:  npm run agent:research          (chạy mãi, hỏi việc mỗi POLL_SECONDS giây)
//        npm run agent:research -- --once (hỏi một lần rồi thoát)
//        npm run agent:leader            (cùng chương trình, chạy cho Agent Leader: kiểm duyệt tên kênh…)
import Anthropic from '@anthropic-ai/sdk';
import { sourceTools, sourceNames, validInput } from './sources.js';

const {
  AUTOFB_URL = 'http://localhost:3000',
  RESEARCH_AGENT_ID,
  LEADER_AGENT_ID,
  RESEARCH_MODEL = 'claude-opus-5-5',
  RESEARCH_EFFORT = 'high',
  POLL_SECONDS = '60'
} = process.env;
const ONCE = process.argv.includes('--once');
// --leader: chạy cho Agent Leader thay vì agent research.
const ROLE = process.argv.includes('--leader') ? 'leader' : 'research';
const ROLE_NAME = ROLE === 'leader' ? 'Agent Leader' : 'agent research';
const MAX_CONTINUATIONS = 40;  // số lượt nối tiếp trong một lần hỏi: tạm dừng giữa lượt tìm web, hoặc chạy công cụ Reddit/YouTube
const MAX_REPAIRS = 1;         // số lần nhờ Claude sửa khi kết quả không phải JSON hợp lệ

// Thị trường → vị trí gần đúng cho tìm kiếm web, để kết quả đúng nước.
const MARKET_LOCATION = { US: 'US', UK: 'GB', CA: 'CA', AU: 'AU', VN: 'VN' };

const client = new Anthropic();
const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Nói chuyện với server AUTOFB ----------
async function api(path, opts = {}) {
  const res = await fetch(AUTOFB_URL + path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
  return res;
}
// Không ghi RESEARCH_AGENT_ID thì lấy agent research duy nhất trong hệ thống.
async function resolveAgentId() {
  const fixed = ROLE === 'leader' ? LEADER_AGENT_ID : RESEARCH_AGENT_ID;
  if (fixed) return fixed;
  const ws = await (await api('/api/ws')).json();
  const list = ws.agents.filter(a => (a.role || a.template) === ROLE);
  if (list.length === 1) return list[0].id;
  if (!list.length) throw new Error(ROLE === 'leader' ? 'Chưa có Agent Leader. Tạo ở trang Tổ chức agent rồi chạy lại.' : 'Chưa có agent research. Tạo trong dashboard (Research → Quét chủ đề) rồi chạy lại.');
  const key = ROLE === 'leader' ? 'LEADER_AGENT_ID' : 'RESEARCH_AGENT_ID';
  throw new Error(`Có nhiều ${ROLE_NAME}. Ghi ${key} vào .env, chọn một trong: ` + list.map(a => `${a.id} (${a.name})`).join(', '));
}
// Báo tiến trình cho dashboard. Gom lại, gửi tối đa 4 giây một lần; force để gửi ngay khi đổi giai đoạn.
function progressReporter(taskId) {
  const s = { phase: '', text: '', searches: 0, fetches: 0 };
  let last = 0, timer = null;
  const send = () => { last = Date.now(); clearTimeout(timer); timer = null;
    api(`/api/tasks/${taskId}/progress`, { method: 'POST', body: JSON.stringify(s) }).catch(() => {}); };
  const report = (patch, force) => {
    Object.assign(s, patch);
    if (force || Date.now() - last > 4000) send();
    else if (!timer) timer = setTimeout(send, 4000 - (Date.now() - last));
  };
  // Nhịp đều 20 giây để dashboard biết agent vẫn đang chạy khi Claude suy nghĩ lâu.
  const beat = setInterval(() => send(), 20000);
  return { s, report, stop: () => { clearInterval(beat); clearTimeout(timer); } };
}
async function release(taskId, reason) {
  try { await api(`/api/tasks/${taskId}/release`, { method: 'POST', body: JSON.stringify({ reason: String(reason).slice(0, 500) }) }); }
  catch (err) { log('Không trả được task về server:', err.message); }
}

// ---------- Dựng lời nhắc từ gói ngữ cảnh ----------
function systemPrompt(p) {
  const a = p.agent;
  const list = (title, items) => items?.length ? `\n\n## ${title}\n${items.map(x => `- ${x}`).join('\n')}` : '';
  return (a.prompt || `Bạn là ${a.name}. ${a.mission}`) +
    list('Luật chung của hệ thống (bắt buộc)', a.globalRules) +
    list('Luật riêng của agent', a.rules) +
    list('Định nghĩa xong', a.definitionOfDone) +
    '\n\n## Môi trường chạy\nCông cụ bạn có: `web_search` (tìm kiếm web), `web_fetch` (đọc một trang công khai)' +
    (sourceTools.length ? `, ${sourceTools.map(t => '`' + t.def.name + '`').join(', ')} (${sourceNames.join(', ')}, qua API chính thức; ưu tiên dùng thay vì đọc trang web của các nguồn này)` : '') + '. ' +
    `Không có ${['Reddit API', 'YouTube Data API', 'Meta Ad Library API'].filter(n => !sourceNames.includes(n)).join(', ')}: nguồn nào thiếu API thì đọc trang công khai nếu được, không truy cập được thì ghi vào \`coverage\` hoặc \`notes\`. ` +
    (ROLE === 'leader' && /tên/i.test(p.task.step.name || '') ? 'Kiểm duyệt tên: được xem kết quả tìm kiếm có trang Facebook, Instagram (tên, mô tả ngắn), nhưng không mở hay đọc các trang đó. ' : 'Facebook, Instagram, Threads bị chặn và không được đọc. ') +
    'Trả lời cuối cùng chỉ gồm đúng một JSON.';
}
function userPrompt(p) {
  const t = p.task;
  return [
    `# Task: ${t.title}`,
    `Bước hiện tại: ${t.step.index + 1}. “${t.step.name}”. Chỉ làm bước này và trả về đúng định dạng của bước này trong prompt.`,
    `Hôm nay: ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## Mô tả task',
    t.desc || '(trống)',
    p.lessons?.length ? `\n## Bài học từ second brain (áp dụng tất cả)\n${p.lessons.map(x => `- ${x}`).join('\n')}` : '',
    ...[['kien-thuc', 'Kiến thức trong Second Brain'], ['mau', 'Mẫu hay đã chạy tốt'], ['lien-ket', 'Tài liệu tham khảo'], ['tong-ket', 'Việc bạn đã làm gần đây (tự tổng kết)']].map(([k, h]) =>
      p.brain?.[k]?.length ? `\n## ${h}\n${p.brain[k].map(x => `- ${x.title ? x.title + ': ' : ''}${x.text}${x.url ? ` (${x.url})` : ''}`).join('\n')}` : ''),
    t.returnNotes?.length ? `\n## Lý do lần trước bị trả lại (sửa đúng các điểm này trước)\n${t.returnNotes.map(x => `- ${x}`).join('\n')}` : '',
    t.previousOutputs?.length ? `\n## Kết quả các bước trước\n${t.previousOutputs.map(o => `### ${o.step}\n${o.text}`).join('\n\n')}` : '',
    '\n## Tự tổng kết\nThêm vào JSON khóa \`_brain\` để tự tổng kết vào Second Brain của bạn: { \"tom_tat\": \"1–2 câu: bạn đã làm gì, kết quả chính\", \"bai_hoc\": [\"tối đa 3 điều rút ra để lần sau làm tốt hơn\"], \"mau\": [\"cách làm hay đáng giữ, nếu có\"], \"kien_thuc\": [\"hiểu biết mới về ngách, khán giả, nếu có\"] }. Không lặp lại bài học đã có trong Second Brain.'
  ].filter(Boolean).join('\n');
}
function tools(p) {
  const m = /\(([A-Z]{2})\)/.exec(p.task.desc || '');
  const country = MARKET_LOCATION[m?.[1]];
  const blocked = ['facebook.com', 'instagram.com', 'threads.net'];
  // Kiểm duyệt tên: Leader được thấy kết quả tìm kiếm công khai từ Facebook/Instagram (tên page), vẫn không đọc trang.
  const nameCheck = ROLE === 'leader' && /tên/i.test(p.task.step.name || '');
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 25, ...(nameCheck ? {} : { blocked_domains: blocked }),
      ...(country ? { user_location: { type: 'approximate', country } } : {}) },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 20, blocked_domains: blocked },
    // Công cụ chạy trên máy: đầu vào stream sớm, nên tự kiểm tra trước khi chạy (validInput).
    ...sourceTools.map(t => ({ ...t.def, eager_input_streaming: true }))
  ];
}
// Chạy các lời gọi công cụ Reddit/YouTube trong một lượt, trả tất cả kết quả trong một tin nhắn.
async function runClientTools(blocks) {
  return Promise.all(blocks.map(async b => {
    const tool = sourceTools.find(t => t.def.name === b.name);
    if (!tool) return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: `Không có công cụ ${b.name}` };
    const bad = validInput(tool.def, b.input);
    if (bad) return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'INVALID_INPUT: ' + bad };
    try {
      const data = await tool.run(b.input);
      return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(data) };
    } catch (err) {
      const net = err.cause?.code ? ` (không kết nối được: ${err.cause.code})` : '';
      return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: err.message + net };
    }
  }));
}

// ---------- Gọi Claude ----------
// Một lần hỏi có thể gồm nhiều lượt: tìm web dài bị tạm dừng (pause_turn) thì gửi lại lượt dở để nối tiếp;
// Claude gọi công cụ Reddit/YouTube (tool_use) thì chạy trên máy rồi gửi kết quả về.
async function ask(system, messages, toolList, prog) {
  let message, usage = { input: 0, output: 0, cacheRead: 0 };
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const stream = client.beta.messages.stream({
      model: RESEARCH_MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: RESEARCH_EFFORT },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: toolList,
      messages
    });
    // Mỗi lần Claude gọi tìm kiếm hoặc đọc trang, đếm lên và báo về dashboard.
    stream.on('contentBlock', b => {
      if (!prog) return;
      if (b.type === 'server_tool_use' && b.name === 'web_search') prog.report({ searches: prog.s.searches + 1, text: 'Tìm: ' + (b.input?.query || '') });
      else if (b.type === 'server_tool_use' && b.name === 'web_fetch') prog.report({ fetches: prog.s.fetches + 1, text: 'Đọc: ' + (b.input?.url || '') });
      else if (b.type === 'tool_use') prog.report(/search/.test(b.name)
        ? { searches: prog.s.searches + 1, text: `${b.name.startsWith('reddit') ? 'Reddit' : 'YouTube'}: ${b.input?.query || ''}` }
        : { fetches: prog.s.fetches + 1, text: `${b.name.startsWith('reddit') ? 'Reddit' : 'YouTube'}: đọc bình luận` });
    });
    message = await stream.finalMessage();
    usage.input += message.usage.input_tokens || 0;
    usage.output += message.usage.output_tokens || 0;
    usage.cacheRead += message.usage.cache_read_input_tokens || 0;
    // Kiểm tra trước khi chạy công cụ: lượt bị từ chối hoặc bị cắt có thể chứa lời gọi công cụ dở.
    if (message.stop_reason === 'refusal') throw new Error('Claude từ chối task: ' + (message.stop_details?.explanation || message.stop_details?.category || 'không rõ lý do'));
    if (message.stop_reason === 'max_tokens') throw new Error('Kết quả quá dài, bị cắt ở giới hạn token');
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      log('  Claude tạm dừng giữa lượt tìm web, nối tiếp…');
    } else if (message.stop_reason === 'tool_use') {
      const calls = message.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: message.content });
      messages.push({ role: 'user', content: await runClientTools(calls) });
      log(`  Chạy ${calls.map(c => c.name).join(', ')}`);
    } else break;
  }
  if (message.stop_reason === 'pause_turn' || message.stop_reason === 'tool_use') throw new Error(`Vẫn chưa xong sau ${MAX_CONTINUATIONS} lượt nối tiếp`);
  const searches = message.usage.server_tool_use?.web_search_requests;
  log(`  Token vào ${usage.input}, ra ${usage.output}, đọc từ cache ${usage.cacheRead}${searches != null ? `, tìm web ${searches} lần (lượt cuối)` : ''}`);
  return message;
}

// Lấy JSON từ chữ Claude trả về; chấp nhận cả khi bị bọc trong ```.
function extractJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('không thấy JSON');
  return JSON.parse(t.slice(a, b + 1));
}
// Kiểm tra cấu trúc tối thiểu theo bước, để không nộp thứ dashboard không đọc được.
function check(data, stepIndex, stepName = '') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'kết quả phải là một object JSON';
  if (ROLE === 'leader') {
    if (!/tên/i.test(stepName)) return null;
    if (!Array.isArray(data.checks)) return 'bước “Kiểm duyệt tên kênh” cần mảng `checks`';
    const i = data.checks.findIndex(c => !c?.channel || !Array.isArray(c.names) || !c.names.length || c.names.some(n => !n?.name || !['trong', 'gan-giong', 'trung'].includes(n.result)));
    return i >= 0 ? `mục kiểm tra thứ ${i + 1} thiếu channel/names, hoặc result không thuộc trong, gan-giong, trung` : null;
  }
  if (stepIndex === 0) return Array.isArray(data.findings) ? null : 'bước “Quét nguồn” cần mảng `findings`';
  if (stepIndex >= 2) {
    // Bước 3 “Đề xuất kênh”: mỗi kênh đủ trường để Agent Leader duyệt.
    if (!Array.isArray(data.channels)) return 'bước “Đề xuất kênh” cần mảng `channels`';
    const i = data.channels.findIndex(c => !c?.name || !c.positioning || !Array.isArray(c.pillars) || c.pillars.length < 3 || !Array.isArray(c.videos) || c.videos.length < 2 || !Array.isArray(c.topics) || !c.topics.length || !c.monetization);
    if (i >= 0) return `kênh thứ ${i + 1} thiếu name, positioning, monetization, topics, hoặc có dưới 3 pillars / 2 videos`;
    return null;
  }
  if (!Array.isArray(data.topics)) return 'bước “Tổng hợp chủ đề” cần mảng `topics`';
  const bad = data.topics.findIndex(t => !t?.title || ['demand', 'growth', 'engagement', 'competition', 'monetization'].some(k => !Number.isInteger(t[k]) || t[k] < 1 || t[k] > 5));
  if (bad >= 0) return `chủ đề thứ ${bad + 1} thiếu \`title\` hoặc có điểm không phải số nguyên 1–5`;
  const names = new Set(data.topics.map(t => t.title));
  const ideaBad = (data.pageIdeas || []).find(x => (x.topics || []).some(n => !names.has(n)));
  if (ideaBad) return `gợi ý page “${ideaBad.name}” nhắc tới chủ đề không có trong \`topics\``;
  return null;
}
const textOf = msg => msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

async function runTask(p, prog) {
  const system = systemPrompt(p);
  const messages = [{ role: 'user', content: userPrompt(p) }];
  const toolList = tools(p);
  const phase = ROLE === 'leader' ? `Leader: ${p.task.step.name}` : ['Đang quét nguồn', 'Đang tổng hợp chủ đề', 'Đang đề xuất kênh'][Math.min(p.task.step.index, 2)];
  prog.report({ phase, text: ROLE === 'leader' ? 'Claude đang tìm tên trên Facebook, nhãn hiệu và mạng xã hội' : p.task.step.index >= 2 ? 'Claude đang gom chủ đề thành kênh' : 'Claude đang lên kế hoạch tìm kiếm' }, true);
  let msg = await ask(system, messages, toolList, prog);
  for (let r = 0; ; r++) {
    let problem, data;
    try { data = extractJson(textOf(msg)); problem = check(data, p.task.step.index, p.task.step.name); }
    catch (err) { problem = 'JSON không hợp lệ: ' + err.message; }
    if (!problem) return data;
    if (r >= MAX_REPAIRS) throw new Error('Kết quả không dùng được: ' + problem);
    log('  Kết quả chưa đúng định dạng (' + problem + '), nhờ Claude sửa…');
    prog.report({ phase: 'Đang sửa định dạng kết quả', text: problem }, true);
    messages.push({ role: 'assistant', content: msg.content });
    messages.push({ role: 'user', content: `Kết quả chưa dùng được: ${problem}. Trả lại đúng một JSON theo định dạng của bước “${p.task.step.name}”, không thêm chữ nào ngoài JSON. Không cần tìm thêm trừ khi thật sự thiếu.` });
    msg = await ask(system, messages, toolList, prog);
  }
}

// ---------- Vòng lặp chính ----------
async function main() {
  const agentId = await resolveAgentId();
  log(`${ROLE_NAME} ${agentId} đang chờ việc từ ${AUTOFB_URL} (model ${RESEARCH_MODEL}, effort ${RESEARCH_EFFORT}).`);
  for (;;) {
    let res;
    try { res = await api(`/api/agents/${agentId}/next`); }
    catch (err) { log('Không gọi được server AUTOFB:', err.message); res = null; }
    if (res?.status === 200) {
      const p = await res.json();
      log(`Nhận task “${p.task.title}”, bước ${p.task.step.index + 1} “${p.task.step.name}”.`);
      const prog = progressReporter(p.task.id);
      try {
        const data = await runTask(p, prog);
        prog.stop();
        const out = await api(`/api/tasks/${p.task.id}/result`, { method: 'POST', body: JSON.stringify({ output: JSON.stringify(data, null, 2) }) });
        const j = await out.json();
        if (!out.ok) throw new Error('Server từ chối kết quả: ' + (j.error || out.status));
        const n = ROLE === 'leader' ? (Array.isArray(data.checks) ? `kiểm tra tên cho ${data.checks.length} kênh` : 'kết quả') : p.task.step.index === 0 ? `${data.findings.length} bằng chứng` : p.task.step.index >= 2 ? `${data.channels.length} đề xuất kênh` : `${data.topics.length} chủ đề, ${(data.pageIdeas || []).length} gợi ý page`;
        log(`Đã nộp ${n}. Task giờ ở trạng thái: ${j.status}.`);
        continue; // có thể còn bước tiếp theo hoặc task khác, hỏi lại ngay
      } catch (err) {
        prog.stop();
        const msg = err instanceof Anthropic.AuthenticationError ? 'Chưa có hoặc sai khóa API Anthropic (ANTHROPIC_API_KEY)'
          : err instanceof Anthropic.RateLimitError ? 'Claude đang giới hạn tốc độ, thử lại sau'
          : err instanceof Anthropic.APIError ? `Claude API lỗi ${err.status}: ${err.message}`
          : err.message;
        log('Lỗi:', msg);
        await release(p.task.id, msg);
        if (err instanceof Anthropic.AuthenticationError) process.exit(1);
      }
    } else if (res?.status === 423) log('Hệ thống đang dừng khẩn, chờ.');
    else if (res && res.status !== 204) log('Server trả về', res.status, (await res.text()).slice(0, 200));
    if (ONCE) break;
    await sleep(Number(POLL_SECONDS) * 1000);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
