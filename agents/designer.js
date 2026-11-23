// Chương trình chạy Agent designer trên máy: vẽ ảnh mẫu (moodboard) cho đề xuất kênh bằng API tạo ảnh của OpenAI.
// Vòng lặp: hỏi server AUTOFB có task không (GET /api/agents/<id>/next) → với mỗi prompt trong task.payload.images,
// gọi OpenAI tạo ảnh → tải ảnh lên server (POST /api/media) → nộp danh sách ảnh (POST /api/tasks/<id>/result).
// Ảnh ở bước hình hóa ý tưởng nên mặc định chất lượng thấp, rẻ và nhanh.
//
// Chạy:  npm run agent:designer          (chạy mãi, hỏi việc mỗi POLL_SECONDS giây)
//        npm run agent:designer -- --once (hỏi một lần rồi thoát)

const {
  AUTOFB_URL = 'http://localhost:3000',
  DESIGNER_AGENT_ID,
  OPENAI_API_KEY,
  OPENAI_BASE_URL = 'https://api.openai.com/v1',
  OPENAI_IMAGE_MODEL = 'gpt-image-1-mini',
  OPENAI_IMAGE_QUALITY = 'low',
  OPENAI_IMAGE_SIZE = '1536x1024',
  POLL_SECONDS = '60'
} = process.env;
const ONCE = process.argv.includes('--once');
const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Luật chung cho mọi ảnh: không thương hiệu, không người thật, không chữ.
const GUARD = 'Casual realistic photo, idea sketch quality is fine. No logos, no brand names, no readable text, no celebrities or real identifiable people, no watermarks.';

const api = (p, opts = {}) => fetch(AUTOFB_URL + p, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });

async function resolveAgentId() {
  if (DESIGNER_AGENT_ID) return DESIGNER_AGENT_ID;
  const ws = await (await api('/api/ws')).json();
  const list = ws.agents.filter(a => (a.role || a.template) === 'designer');
  if (list.length === 1) return list[0].id;
  if (!list.length) throw new Error('Chưa có Agent designer. Tạo ở trang Tổ chức agent (hoặc bấm “Giao Designer vẽ ảnh mẫu”) rồi chạy lại.');
  throw new Error('Có nhiều Agent designer. Ghi DESIGNER_AGENT_ID vào .env, chọn một trong: ' + list.map(a => `${a.id} (${a.name})`).join(', '));
}
function progress(taskId, s) {
  api(`/api/tasks/${taskId}/progress`, { method: 'POST', body: JSON.stringify(s) }).catch(() => {});
}
async function release(taskId, reason) {
  try { await api(`/api/tasks/${taskId}/release`, { method: 'POST', body: JSON.stringify({ reason: String(reason).slice(0, 500) }) }); }
  catch (err) { log('Không trả được task về server:', err.message); }
}

// Gọi OpenAI tạo một ảnh, trả về Buffer jpeg.
async function generate(prompt) {
  const res = await fetch(OPENAI_BASE_URL + '/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt: `${prompt}. ${GUARD}`, size: OPENAI_IMAGE_SIZE, quality: OPENAI_IMAGE_QUALITY, n: 1, output_format: 'jpeg' })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.error?.message || res.status;
    if (res.status === 401) throw new Error('Sai hoặc thiếu OPENAI_API_KEY trong .env');
    if (/model/i.test(msg)) throw new Error(`OpenAI không nhận mô hình “${OPENAI_IMAGE_MODEL}”: ${msg}. Đổi OPENAI_IMAGE_MODEL trong .env.`);
    throw new Error('OpenAI báo lỗi: ' + msg);
  }
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI không trả ảnh');
  return Buffer.from(b64, 'base64');
}
async function upload(buf) {
  const res = await fetch(AUTOFB_URL + '/api/media', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: buf });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Server không nhận ảnh: ' + (j.error || res.status));
  return j.url;
}

async function runTask(p) {
  const items = p.task.payload?.images;
  if (!Array.isArray(items) || !items.length) throw new Error('Task không có danh sách ảnh (payload.images). Giao lại từ thẻ kênh.');
  const out = [], started = Date.now();
  for (const [i, it] of items.entries()) {
    progress(p.task.id, { phase: `Đang vẽ ảnh ${i + 1}/${items.length}`, text: it.caption || '', searches: 0, fetches: i, startedAt: started });
    log(`  Ảnh ${i + 1}/${items.length}: ${it.caption || it.prompt.slice(0, 60)}`);
    const url = await upload(await generate(it.prompt));
    out.push({ index: it.index ?? i, caption: it.caption || '', prompt: it.prompt, url, model: OPENAI_IMAGE_MODEL, quality: OPENAI_IMAGE_QUALITY, ai_label: true });
  }
  return { images: out, notes: `Ảnh nháp để hình hóa ý tưởng (${OPENAI_IMAGE_MODEL}, chất lượng ${OPENAI_IMAGE_QUALITY}). Ảnh do AI tạo; dùng công khai thì gắn nhãn AI.` };
}

async function main() {
  if (!OPENAI_API_KEY) { log('Thiếu OPENAI_API_KEY trong .env. Lấy ở platform.openai.com > API keys.'); process.exit(1); }
  const agentId = await resolveAgentId();
  log(`Agent designer ${agentId} đang chờ việc từ ${AUTOFB_URL} (OpenAI ${OPENAI_IMAGE_MODEL}, ${OPENAI_IMAGE_QUALITY}, ${OPENAI_IMAGE_SIZE}).`);
  for (;;) {
    let res;
    try { res = await api(`/api/agents/${agentId}/next`); }
    catch (err) { log('Không gọi được server AUTOFB:', err.message); res = null; }
    if (res?.status === 200) {
      const p = await res.json();
      log(`Nhận task “${p.task.title}”.`);
      try {
        const data = await runTask(p);
        const r = await api(`/api/tasks/${p.task.id}/result`, { method: 'POST', body: JSON.stringify({ output: JSON.stringify(data, null, 2) }) });
        const j = await r.json();
        if (!r.ok) throw new Error('Server từ chối kết quả: ' + (j.error || r.status));
        log(`Đã nộp ${data.images.length} ảnh. Task giờ ở trạng thái: ${j.status}.`);
        continue;
      } catch (err) {
        log('Lỗi, trả task về server:', err.message);
        await release(p.task.id, err.message);
      }
    } else if (res?.status === 423) log('Đang dừng khẩn, chờ…');
    if (ONCE) break;
    await sleep(+POLL_SECONDS * 1000);
  }
}
main().catch(err => { log(err.message); process.exit(1); });
