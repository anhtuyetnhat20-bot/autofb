# AUTOFB: bối cảnh dự án cho Claude Code

File này gom toàn bộ thông tin dự án: PRD, các quyết định đã chốt, hiện trạng code, kiến trúc, việc cần làm tiếp và luật bắt buộc. Đọc hết trước khi sửa code.

Ngày cập nhật: 03/11/2026. Ngôn ngữ giao diện và tài liệu: tiếng Việt. Tên biến, hàm, endpoint: tiếng Anh hoặc không dấu.

---

## 1. Sản phẩm là gì

Hệ thống AI agent dùng nội bộ để **xây và nuôi fanpage Facebook từ con số 0**, chỉ làm Facebook Page, vận hành qua **Meta Graph API chính thức**. Con người chọn hướng, đặt luật và kiểm tra ngẫu nhiên, không làm từng bài.

Hai giai đoạn:

1. **Chiến lược** (khi mở page mới): AI nghiên cứu, chấm điểm ngách, đề xuất thương hiệu, sản phẩm, kế hoạch 90 ngày. Team chọn và tự tạo page.
2. **Nuôi kênh** (hằng ngày): agent viết kịch bản, dựng Reel/ảnh, tự kiểm duyệt, đăng theo lịch, trả lời bình luận, đọc số liệu, điều chỉnh tuần sau.

Mục đích kinh doanh: kênh có tương tác thật là tài sản để kiếm tiền từ nền tảng, kéo traffic cho sản phẩm/affiliate, và làm page chạy quảng cáo rẻ hơn.

Mục tiêu: **v1.0 ngày 30/11/2026**, chạy thử 3–5 page. Instagram, TikTok, YouTube nằm ngoài phạm vi.

Team: Tuyết (PO, quản trị), anh Mạnh và chị Dương (mạnh SEO, làm chủ prompt và luật của agent), cộng phần kỹ thuật.

### 1.1 Bốn agent

| Agent | Khi chạy | Việc | Mô hình |
| --- | --- | --- | --- |
| Chiến lược kênh | Theo yêu cầu, mốc 30 ngày | Chấm 5–10 ngách, 3 phương án thương hiệu, cách kiếm tiền, kế hoạch 90 ngày | Mạnh, có tìm kiếm |
| Nội dung | Hằng ngày | Ý tưởng, kịch bản Reel 15–60 giây, 2–3 biến thể hook, caption, chỉ dẫn dựng. Đầu ra JSON | Mạnh |
| Kiểm duyệt | Hằng ngày | Chấm độc lập bài đã dựng, không thấy lập luận của agent nội dung. Trả về kèm lý do; bị trả quá 2 lần thì chuyển người | Mạnh |
| Cộng đồng | Hằng ngày | Nhận bình luận qua webhook, phân loại, trả lời theo giọng page, ghim, ẩn spam | Rẻ hơn |

Thêm một lần gọi AI mỗi tuần để viết báo cáo và ghi bài học vào bộ nhớ page. Mọi việc theo quy tắc cố định (lịch chạy, dựng media theo mẫu, đăng bài, kéo số liệu) là **code thường**, không phải agent.

### 1.2 Mức tự động theo từng page

| Mức | Agent tự làm | Người làm |
| --- | --- | --- |
| 1, duyệt từng bài | Mọi thứ đến bản nháp | Duyệt mỗi bài và mỗi câu trả lời |
| 2, tự đăng có hẹn giờ | Đăng nếu qua kiểm duyệt, người có thời gian để chặn | Xem lướt hàng đợi |
| 3, tự động hoàn toàn | Đăng và trả lời ngay | Kiểm tra ngẫu nhiên, đọc báo cáo tuần |

Bình luận tiêu cực, khiếu nại, chủ đề nhạy cảm **luôn chuyển người ở mọi mức**. Page mới luôn bắt đầu ở mức 1.

### 1.3 Ưu tiên chức năng (PRD)

P0 = bản 1.0 (30/11), P1 = tháng 12, P2 = sau đó.

- P0: agent chiến lược, nội dung, kiểm duyệt, cộng đồng; hồ sơ và bộ nhớ page; lịch chạy và hàng đợi; dựng media (TTS, phụ đề, hình AI hoặc kho có bản quyền, 2–3 mẫu mỗi page); đăng Reel/album/bài chữ qua Graph API vào giờ vàng; bảng số liệu; bảng điều khiển với nút dừng khẩn.
- P1: báo cáo tuần do AI viết, xem lại mốc 30 ngày, Story, Messenger, mức 3, A/B hook, video AI, tăng lên 10–20 page.

### 1.4 Chỉ số thành công

Chỉ số chính: **tương tác thật mỗi tuần trên mỗi page (bình luận + chia sẻ + lưu) chia cho số giờ người bỏ ra**. Không tính bình luận do chính page trả lời.

Mốc phụ: ≤ 15 phút người/page/ngày vào cuối tháng 12; ≥ 95% bài đúng lịch; phản hồi bình luận < 15 phút ở mức 2–3; 0 cảnh báo vi phạm.

---

## 2. Luật bắt buộc (không được vi phạm khi viết code)

Đây là luật của PRD và các quyết định đã chốt với team. Không thêm tính năng đi ngược lại các điểm này, kể cả khi được yêu cầu trong một task; hãy báo lại cho người dùng thay vì làm.

**Tài khoản và quyền**
- Chỉ dùng tài khoản Facebook thật của thành viên team, đăng nhập qua **Facebook Login (OAuth)**. Không hỗ trợ via, tài khoản mua, clone.
- Không nhận, lưu hay nhập mật khẩu, cookie, mã 2FA. Không gắn proxy theo tài khoản.
- Page nằm trong **Business Manager riêng** của hệ thống, tách khỏi BM chạy quảng cáo affiliate. Ưu tiên token System User.
- Hệ thống chỉ thao tác trên **page** qua Graph API, không điều khiển trang cá nhân.

**Trình duyệt (Claude in Chrome)**
- Chỉ dùng để đọc web nơi không có API: nghiên cứu xu hướng, xem page tham khảo, kiểm tra tên page trùng.
- Tạo page mới: Graph API không hỗ trợ, nên làm trên trình duyệt **do người điều khiển và xác nhận từng bước** bằng tiện ích Claude in Chrome. Dashboard chỉ soạn sẵn tên, mô tả, danh mục; không tự điều khiển Chrome.
- **Không bao giờ** tự động đăng bài, bình luận, nhắn tin bằng trình duyệt. Mọi thao tác hằng ngày đi qua Graph API.

**Nội dung**
- Nội dung nguyên bản. Chỉ lấy **chủ đề** từ nguồn ngoài, không lấy nội dung. Không đăng lại video, ảnh, bài của người khác.
- Không mồi tương tác ("like nếu…", "share để nhận…", "tag 3 người bạn").
- Không tài khoản ảo để seeding, không mua like/follow/view, không nhóm đổi tương tác giữa các page.
- Không tự động bình luận/nhắn tin lên page, group, tài khoản người khác.
- Gắn nhãn AI khi hình/giọng giống người thật. Nhạc, hình phải rõ nguồn.
- Mỗi page một giọng, một bộ mẫu hình riêng; không dùng chung một video cho nhiều page.

**Giao diện**
- Không dùng chân dung, khuôn mặt hay biếm họa người thật (kể cả người nổi tiếng) cho nhân vật agent hay bất kỳ đâu trong UI. Nhân vật agent là nhân vật tự thiết kế.

---

## 3. Hiện trạng repo

```
autofb/
├── CLAUDE.md          # file này
├── README.md          # hướng dẫn cài đặt cho người dùng
├── package.json       # "type": "module", express 5.3.0, Node >= 20.6
├── .env.example
├── .gitignore         # node_modules/, .env, data/
├── server.js          # server Express: không gian làm việc chung, giao thức agent, OAuth Facebook, đọc page
├── agents/
│   ├── research.js    # chương trình chạy agent research trên máy (npm run agent:research)
│   └── sources.js     # công cụ Reddit API, YouTube Data API cho agent research (bật khi có khóa trong .env)
├── scripts/
│   ├── start-autofb.cmd       # bật server + agent research trong cửa sổ thu nhỏ, bỏ qua cái đang chạy
│   └── install-autostart.ps1  # tạo/gỡ (-Remove) lối tắt AUTOFB trong thư mục Startup của Windows
├── prompts/
│   └── research.md    # prompt vai trò của agent research (anh Mạnh, chị Dương làm chủ)
├── public/
│   └── index.html     # toàn bộ dashboard (HTML + CSS + JS trong 1 file)
└── data/
    ├── store.json     # tạo khi chạy; CHỨA TOKEN, không commit
    └── workspace.json # thành viên, agent, task, second brain, page, cài đặt
```

### 3.0 Hướng đi từ 03/11/2026: mỗi người build agent riêng

Theo hướng team chốt: MVP chưa cần một platform lớn. Các bước:

1. Mỗi người tự build agent cho phần mình phụ trách, kèm second brain và công cụ trên máy mình, có định nghĩa “xong” (DoD) và chỉ số đo.
2. Các agent nói chuyện với nhau qua một giao thức chung. Dashboard là nơi điều phối kiểu quản lý dự án: ai cần gì thì giao task cho người đó; người nhận tự chọn bước nào agent của mình cần duyệt, hoặc để agent tự duyệt cuối khi đã ổn. Mỗi lần duyệt, trả lại, chỉnh sửa đều được ghi vào second brain.
3. Khi tự động đã ổn, có thể gom về một platform (hoặc không), rồi giao cho hệ một mục tiêu lớn (ví dụ 10.000 người theo dõi). **Chưa làm.**

### 3.0a Cơ cấu đội agent và Second Brain (chốt 05/11/2026)

- **Leader** (agent, không phải người) ở trên cùng: đặt chiến lược, chia mục tiêu thành task, đo kết quả, phản hồi, và chấm bài cuối trước khi đăng (thay cho agent kiểm duyệt riêng; vẫn phải chấm độc lập, không đọc lập luận của agent làm bài).
- Năm agent chức năng theo thứ tự một bài: **Research → Content → Designer → Editor → Community**. Template: `research`, `noidung`, `designer`, `editor`, `congdong`, cùng `leader`. `kiemduyet`, `chienluoc` còn trong `TEMPLATES` với `legacy:true` để agent cũ vẫn mở được, không hiện khi tạo mới.
- Agent có thêm `role` (khóa ở `ROLES`) và `reportsTo` (id Leader). `roleOf(a)` lấy `role` hoặc `template`. Màu agent theo vai trò. Người (`members`) chỉ còn là người duyệt.
- Trang **Tổ chức agent** (`#to-chuc`, `vOrg()`): thẻ Leader, sơ đồ 5 agent, nút “Dựng đủ đội”, mục tiêu (`goals`), phản hồi gần đây của Leader, người duyệt. Thanh bên có nhóm **Đội agent**.
- **Second Brain** (tab `brain` của agent, `brainSpace()`): mục `brain` có thêm `kind` ∈ `bai-hoc, phan-hoi, kien-thuc, mau, lien-ket`, `title`, `url`, `tags`, `pinned`. Mục cũ không có `kind` coi là `bai-hoc`. Phản hồi Leader: `source:'leader'`, `kind:'phan-hoi'`, `by` = id agent Leader.
- Gói ngữ cảnh: `agent.role`, `agent.reportsTo`; `lessons` = mục đang dùng loại bài học và phản hồi; `brain` = `{ 'kien-thuc':[], mau:[], 'lien-ket':[] }` (title, text, url, tags); Leader nhận thêm `goals`. `agents/research.js` đưa cả `brain` vào prompt.
- **Chỉ có agent, không có người trong giao diện** (chốt 05/11/2026): bỏ chọn “Bạn đang dùng với tên”, bỏ thẻ thành viên, bỏ chọn người khi giao việc và khi tạo agent. Giao việc là chọn agent. Người vận hành là một danh tính ẩn `OP = 'ban'` (hiện “Bạn”), dùng cho duyệt và lịch sử; `members` chỉ còn mục này. `agentsOnly()` chạy khi tải dữ liệu: chuyển `owner`, `from`, `to`, `by`, `who` trỏ tới người cũ về `ban` rồi xóa người cũ. Bảng điều phối lọc theo agent.
- **Đề xuất kênh** (chốt 05/11/2026): template `research` có bước 3 “Đề xuất kênh” (cần duyệt). Agent research cũ 2 bước được `upgradeAgents()` thêm bước này khi tải dữ liệu. Duyệt bước “Tổng hợp chủ đề” thì chủ đề vào danh sách (`syncScans()` nhập theo từng output, ghi `scans[].done`), agent làm tiếp bước 3, trả `{ channels: [{ name, altNames, priority, topics, positioning, audience, pillars, videos, ugc, monetization, description, category, voice, moodboard: [{ caption, prompt, image? }], risks }], notes }` (xem `prompts/research.md`). `importChannels()` lưu vào `research.channels` với `status` ∈ `cho-leader, duyet, tra-lai`. Ở bước “Chọn ngách”, mỗi kênh là một thẻ (`channelCard()`); Agent Leader duyệt hoặc trả lại từng kênh (ghi chú thành phản hồi trong Second Brain của agent research); quyết hết thì task qua bước (`settleChannelTask()`). Kênh đã duyệt: “Dùng kênh này để tạo page” điền hồ sơ page, “Giao Designer làm ảnh mẫu” tạo task cho agent designer từ `moodboard`. Hiện người vận hành bấm thay Leader vì Leader chưa có chương trình chạy.
- **Kiểm duyệt tên kênh** (chốt 05/11/2026): Agent Leader có bước 4 “Kiểm duyệt tên kênh” (không cần duyệt; `upgradeAgents()` thêm cho Leader cũ). Khi có kênh `cho-leader` chưa kiểm tên, `syncScans()` gọi `nameTask()` tạo task `kind:'ten'` cho Leader với `step` = `until` = chỉ số bước này. Task có `until` chỉ chạy tới bước đó (sửa ở `advance()` và `applyResult()`). Leader trả `{ checks: [{ channel, names: [{ name, result: trong|gan-giong|trung, evidence, note }], recommend, newNames }] }`; `syncNameChecks()` ghi vào `channel.nameCheck.names[nameKey(tên)]`. Nút “Leader duyệt” bị khóa khi tên chính chưa kiểm hoặc `trung`; “Dùng tên này” đổi sang tên dự phòng; kết luận từng tên sửa tay được. Chương trình chạy: `npm run agent:leader` (= `agents/research.js --leader`, prompt `prompts/leader.md`); ở bước kiểm tên Leader được thấy kết quả tìm kiếm có facebook.com/instagram.com nhưng `web_fetch` vẫn chặn các trang đó.
- **Ảnh mẫu do Agent designer vẽ** (chốt 05/11/2026): `agents/designer.js` (`npm run agent:designer`) nhận task `kind:'moodboard'` (`payload: { researchId, channelId, images: [{ index, caption, prompt }] }`, gói ngữ cảnh có `task.payload`), gọi OpenAI Images (`OPENAI_IMAGE_MODEL`, mặc định gpt-image-1-mini, chất lượng low: ảnh nháp hình hóa ý tưởng), tải ảnh lên `POST /api/media` (nhị phân png/jpeg/webp ≤ 15 MB, lưu `data/media`, phục vụ ở `/media/<file>`), nộp `{ images: [{ index, caption, prompt, url }] }`. `syncMoodboards()` gắn `url` vào `channel.moodboard[i].image`. Task có `noReview:true` thì bước cuối không dừng chờ duyệt (sửa ở `submitResult()` và `applyResult()`). Có designer thì kênh chưa có ảnh được tự giao; nút “Giao Designer vẽ ảnh mẫu” tạo designer nếu chưa có. Prompt ảnh luôn kèm: không logo, thương hiệu, chữ, người thật.
- **Tab Claude Code** (`#claude/<chat|agent|may>`, `vClaude()`, server `claude-hub.js` gắn qua `mountClaude()` trước `express.json()` chung). Mọi route `/api/claude`, `/api/run`, `/api/system`, `/api/backup` chỉ nhận yêu cầu có Host là localhost và header `x-autofb: 1` (chặn trang web lạ gọi vào). (1) **Chat**: mỗi cuộc chat là một tiến trình `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default` ở thư mục dự án; nội dung luôn qua stdin, không qua tham số (claude.cmd trên Windows phải chạy qua shell). CLI gửi `control_request` `can_use_tool` khi muốn sửa file hay chạy lệnh; dashboard hiện Cho phép / Luôn cho phép trong chat / Từ chối, server trả `control_response`. Lịch sử lưu `data/claude-chats.json`; tiến trình rảnh 15 phút thì đóng, tin sau nối tiếp bằng `--resume <session_id>`. (2) **Agent đang chạy**: server bật/tắt `agents/research.js` (`--leader`), `agents/designer.js`, `agents/cli-runner.js --role <vai trò>` như tiến trình con, giữ nhật ký, “Tự bật cùng server” lưu `data/runners.json`. `scripts/start-autofb.cmd` chỉ còn bật server. (3) **cli-runner**: chạy agent bằng Claude CLI (gói Claude đã đăng nhập, không cần ANTHROPIC_API_KEY) trong thư mục riêng `data/claude/runner`, chỉ được WebSearch/WebFetch (settings.json chặn Bash, sửa file, đọc Facebook/Instagram/Threads). (4) **Máy này**: kiểm tra Node, Claude CLI, khóa trong .env (chỉ có/không), thử đăng nhập Claude, sao lưu (`GET /api/backup`: workspace, lịch sử chat, cài đặt agent; không có store.json và .env) và khôi phục (giữ bản cũ `workspace.before-restore-*.json`), hướng dẫn chuyển máy.
- **Dây chuyền một bài** (chốt 09/11/2026): `PIPE = { noidung → designer → editor → leader }`. Task (không có `kind`) xong thì `autoForward()` (chạy sau mỗi `pull()` và khi duyệt) tạo task cho agent kế tiếp, mang theo yêu cầu gốc và mọi kết quả trước (`chain` = id task gốc, `parent`, task cũ ghi `forwarded`). Tới Leader là task `kind:'review'` chỉ chạy bước “Chấm bài trước khi đăng” (`until`); `settleReview()` đọc `{ pass, reasons, feedback }`: đạt thì cả chuỗi `ready:true` (“Sẵn sàng đăng”), trượt thì tạo task “Sửa: …” cho Content; `feedback` thành phản hồi Leader trong Second Brain agent tương ứng. Hộp task: agent chưa chạy thì có nút “Bật <agent>” (`/api/run/cli-<vai trò>/start`); ô dán tay thu vào “Tự dán kết quả” và nút “Nộp thay agent”; nút duyệt ghi rõ “Duyệt · chuyển cho …”. Prompt vai trò: `prompts/noidung.md`, `designer.md` (vẽ SVG, xem trước qua `<img>` data URL), `editor.md` (bản dựng: timeline, SRT, nhạc), `congdong.md`, `leader.md` (thêm bước chấm bài). `upgradeAgents()` nạp prompt mẫu cho agent có prompt trống. `cli-runner.js` kiểm JSON theo tên bước (ideas, hooks+scenes, caption, assets/svg, timeline, pass, items). Kết quả agent nộp ghi `by` = id agent.
- Collection mới `goals`: `{ id, title, metric, current, target, unit, due, pageId }`. Server đã thêm vào `COLLS`.

**Thứ tự làm một kênh (chốt 03/11/2026):** Research trước, agent chức năng sau. (1) Chọn thị trường, ưu tiên Mỹ. (2) Agent research quét và social listening để tìm chủ đề người dùng quan tâm. (3) Chọn ngách, soạn hồ sơ page. (4) Tạo page thủ công trên Facebook. (5) Kết nối page. (6) Mới build agent chức năng (nội dung, kiểm duyệt, cộng đồng) cho page đó. Agent research quét mỗi sáng 8h30 (giờ Việt Nam), đưa chủ đề mới và 2–3 gợi ý page.

Văn phòng agent hoạt hình và vòng mô phỏng cũ đã bỏ. Bản cũ nằm ngoài repo, trong thư mục `ban-cu/` cạnh `autofb/` nếu cần tham khảo.

### 3.1 Phần nào thật, phần nào mô phỏng

| Phần | Trạng thái |
| --- | --- |
| Đăng nhập Facebook trong tab mới, đổi token dài hạn | **Thật** (server.js), chỉ bật khi có `FB_APP_ID`, `FB_APP_SECRET` |
| Lấy danh sách page (`/me/accounts`) | **Thật** |
| Thành viên, agent, task, second brain, page, dừng khẩn | **Thật**, lưu trong `data/workspace.json`, dùng chung cả team |
| Giao thức agent lấy task và nộp kết quả | **Thật** (`/api/agents/:id/next`, `/api/tasks/:id/result`) |
| Agent làm việc (gọi mô hình, dùng công cụ) | **Chưa có**: chạy trên máy từng người, ngoài repo này |
| Đăng bài, bình luận, số liệu qua Graph API | **Chưa có** |
| Bản không có server (artifact, mở file) | Dữ liệu mẫu trong `localStorage`, nút “Mô phỏng agent làm” điền kết quả mẫu |

---

### 3.0b Giao diện gọn và agent tự tổng kết (chốt 09/11/2026)

- Menu chính chỉ còn 3 mục: **Hôm nay** (`#hom-nay`: bài cần duyệt với nút Duyệt / Yêu cầu làm lại, việc cần chú ý, bài sẵn sàng đăng, tổng kết mới), **Pages** (`#pages`: kênh và page Facebook, bấm để xem bộ nhận diện, gắn page, giao Content soạn bài), **Đội agent** (`#doi`: luồng một bài, công tắc bật/tắt agent qua `/api/run`, lỗi, Second Brain). Các trang cũ nằm trong nhóm “Cài đặt, nâng cao”. Giữ nguyên theme gradient kính.
- Kênh gắn với page bằng `channel.fbPageId` (id page Facebook); không có thì so tên.
- Second Brain có thêm loại `tong-ket` (Tổng kết task). Agent tự viết: thêm khóa `_brain: { tom_tat, bai_hoc[], mau[], kien_thuc[] }` vào JSON kết quả; server (`selfRecap()` trong server.js) lưu thành ghi nhớ. Khi task xong, dashboard (`syncRecaps()`) bổ sung kết quả duyệt và nhận xét; agent không tự viết thì dashboard tự tổng hợp. Gói ngữ cảnh gửi agent 8 tổng kết gần nhất (`brain['tong-ket']`) và 40 bài học mới nhất.
- “Duyệt” nhanh ở Hôm nay coi như đạt mọi tiêu chí “xong”.

## 4. Server (`server.js`)

Express 5, ES modules, chạy `npm start` = `node --env-file=.env server.js`. Nghe trên `HOST` (mặc định `127.0.0.1`).

### 4.1 Biến môi trường

| Biến | Ý nghĩa |
| --- | --- |
| `FB_APP_ID`, `FB_APP_SECRET` | Thiếu thì server vẫn chạy phần không gian làm việc, chỉ tắt đăng nhập Facebook (`/auth/facebook`, `/api/accounts` trả 503) |
| `FB_CONFIG_ID` | Tùy chọn. Nếu có thì OAuth dùng `config_id` (Facebook Login for Business) thay cho `scope` |
| `GRAPH_VERSION` | Mặc định `v23.0`. Cần cập nhật theo phiên bản mới nhất trong App Dashboard |
| `PORT` | Mặc định 3000 |
| `BASE_URL` | Mặc định `http://localhost:PORT`. Redirect URI = `BASE_URL/auth/facebook/callback`, phải khai báo trong app Meta |
| `HOST` | Mặc định `127.0.0.1` |

Scope đang xin: `pages_show_list, pages_read_engagement, pages_manage_posts, pages_manage_engagement, pages_read_user_content, pages_manage_metadata, read_insights, business_management`.

### 4.2 Endpoint

| Method | Path | Việc |
| --- | --- | --- |
| GET | `/api/health` | `{ ok:true, graphVersion, workspace:true, facebook:bool }`. Dashboard dùng để biết đang chạy cùng server |
| GET | `/api/prompts/:name` | Nội dung `prompts/<name>.md` dạng chữ, đã lược bỏ khối `<!-- -->`. Dashboard dùng khi tạo agent có `promptFile` trong `TEMPLATES` và khi bấm “Nạp prompt mẫu” |
| GET | `/api/ws` | Toàn bộ không gian làm việc: `{ members, agents, tasks, brain, pages, settings, research }`, mỗi cái là mảng, kèm `presence` (agentId → lần cuối gọi `/next` hoặc `/progress`, chỉ trong bộ nhớ) và `now` (giờ server) |
| PUT | `/api/ws/:coll/:id` | Ghi đè một object (body phải có `id` trùng). `coll` ∈ `members, agents, tasks, brain, pages, settings, research` |
| DELETE | `/api/ws/:coll/:id` | Xóa một object |
| GET | `/api/agents/:id/next` | Cho agent trên máy: lấy task cũ nhất ở trạng thái `moi` hoặc `can-sua`, chuyển sang `dang-lam`, trả gói ngữ cảnh. 204 nếu không có việc, 423 khi dừng khẩn |
| POST | `/api/tasks/:id/progress` | Body `{ phase, text, searches, fetches }`. Agent báo đang làm tới đâu; lưu vào `t.progress` (kèm `at`, `startedAt`), chỉ khi task `dang-lam`. `/next` đặt `progress` ban đầu; `/result` và `/release` xóa. `agents/research.js` gửi tối đa 4 giây một lần và nhịp đều 20 giây |
| POST | `/api/tasks/:id/release` | Body `{ reason }`. Agent làm lỗi, trả task đang `dang-lam` về `moi` (hoặc `can-sua` nếu đã bị trả), tăng `errors`, ghi `lastError`. `errors` ≥ 3 thì `blocked:true`: `/next` bỏ qua task đó; dashboard hiện “Agent lỗi” và nút “Cho chạy lại” (xóa `blocked`, `errors`) |
| POST | `/api/tasks/:id/result` | Body `{ output, metrics?, by? }`. Nộp kết quả bước hiện tại; bước cần duyệt → `cho-duyet`, không → sang bước sau hoặc `xong`. 409 nếu task đang chờ duyệt hoặc đã xong |
| GET | `/auth/facebook` | Tạo `state` (chống CSRF, hạn 10 phút, lưu trong Map bộ nhớ), redirect sang hộp thoại OAuth |
| GET | `/auth/facebook/callback` | Đổi code → token ngắn → token dài (`fb_exchange_token`), gọi `/me`, `/me/accounts` (có phân trang), lưu store, trả trang kết quả. Trang này `postMessage({type:'autofb-fb', ok, id})` về tab dashboard và ghi `localStorage['autofb-login']`, rồi tự đóng |
| GET | `/api/accounts` | Danh sách tài khoản kèm page, **không có token** |
| POST | `/api/accounts/:id/rescan` | Gọi lại `/me/accounts` bằng token đã lưu |
| POST | `/api/accounts/:id/connect` | Body `{ pageIds: [] }`, đánh dấu page đã kết nối |
| DELETE | `/api/accounts/:id` | Xóa tài khoản khỏi store |

### 4.3 Định dạng `data/store.json`

```json
{
  "accounts": {
    "<fb user id>": {
      "id": "...", "name": "...",
      "userToken": "...", "tokenExpiresAt": 1790000000000,
      "pages": [{ "id": "...", "name": "...", "category": "...", "fan_count": 0, "link": "...", "tasks": ["CREATE_CONTENT", "MODERATE"], "pageToken": "..." }],
      "connected": ["<page id>"],
      "updatedAt": 0
    }
  }
}
```

Token không bao giờ được trả ra trình duyệt (`publicAccount()` lọc `pageToken`, `userToken`).

`data/workspace.json` có dạng `{ members:{id:obj}, agents:{...}, tasks:{...}, brain:{...}, pages:{...}, settings:{ main:{ id:'main', paused } } }`. Mọi lần ghi đi qua hàng đợi `withWs()` để không đè nhau.

**Lịch quét buổi sáng** (`dailyTick()`, chạy khi server khởi động rồi mỗi phút): mỗi đợt research có `marketDone` và `daily.on`, khi giờ địa phương (`daily.tz`, mặc định `Asia/Ho_Chi_Minh`) qua `daily.time` (mặc định `08:30`) và `lastAuto` khác hôm nay, server tạo task `auto:true` id `tk_auto_<research>_<ngày>` cho agent research (`agentId` của đợt, không có thì agent `template:'research'` đầu tiên), ghi vào `scans`, đặt `lastAuto`. Server bật muộn thì giao bù ngay. Dừng khẩn thì không giao. Agent trên máy người phụ trách phải đang gọi `/next` thì mới nhận.

Logic chuyển bước của task có hai bản: `applyResult()` trong server.js và `submitResult()`/`advance()` trong index.html (cho bản không server). `GLOBAL_RULES`, tên công cụ, `scanDesc()` (mô tả task quét) và hồ sơ page trong gói ngữ cảnh (`pageProfile`) cũng có hai bản. Sửa một bên thì sửa cả hai.

### 4.4 Hạn chế hiện tại của server

- Không có đăng nhập: ai mở dashboard cũng chọn được tên bất kỳ, agent nào cũng gọi được API của agent khác. Server chỉ nghe `127.0.0.1`. Trước khi cho agent ở máy khác gọi vào: thêm đăng nhập dashboard, khóa API riêng cho từng agent, HTTPS.
- Dashboard ghi đè cả object khi lưu (last write wins). Hai người cùng sửa một agent hay một task cùng lúc thì bản lưu sau thắng.
- Lưu bằng file JSON. Theo PRD sẽ chuyển sang Postgres.
- Token người dùng dài hạn khoảng 60 ngày; chưa có job làm mới token hay cảnh báo sắp hết hạn. Nên chuyển sang System User.
- Chưa có webhook, chưa đăng bài, chưa đọc insights.

---

## 5. Dashboard (`public/index.html`)

Một file duy nhất: CSS trong `<style>`, JS trong một IIFE trong `<script>` cuối trang. Không framework, không build. Font Be Vietnam Pro từ Google Fonts. Mặc định giao diện sáng; nút mặt trăng/mặt trời đổi sáng/tối, lưu ở `localStorage['autofb-theme']`.

Phong cách: kính mờ trên nền gradient nhiều đốm màu (tím, xanh, hồng, ngọc). Gradient dùng chung qua biến `--hero`, `--accent-g`, `--g-violet`, `--g-blue`, `--g-pink`, `--g-teal`, `--g-amber`. Mục đang chọn ở thanh bên và nút chính tô `--accent-g` có bóng `--glow`. Thẻ số liệu đầu tiên tô `--hero`. Trang “Không gian của tôi” có biểu đồ cột 7 ngày (`activityCard()`: kết quả nộp và task xong của agent mình) và thẻ “Tiến tới tự động” (`progressCard()`).

### 5.1 Bố cục

- Một cửa sổ kính lớn: thanh bên trái + vùng chính. Màn hẹp (< 820px) thanh bên thành menu trượt.
- Thanh bên theo thứ tự làm việc: nhóm **Khởi tạo kênh** (Research thị trường kèm số bước đã xong `n/6`, Fanpage); nhóm **Vận hành** (Không gian của tôi, Bảng điều phối, Thành viên và agent); nhóm **Agent của tôi** (từng agent + “Tạo agent”). Ô nét đứt ở đáy cho biết đang nối server hay đang ở bản thử.
- Thanh trên: nhãn chế độ, Dừng khẩn, đổi theme, nút chọn “Bạn đang dùng với tên” (chưa có đăng nhập thật).
- Tiêu đề trang lớn + nút hành động bên phải (`#phActs`).

### 5.2 Định tuyến

Hash: `#research/<researchId>/<bước>` với bước ∈ `thi-truong, quet, chon, tao-page, ket-noi, agent` (mặc định khi chưa có page và agent), `#toi` (mặc định khi đã có), `#agent/<id>/<tab>` với tab ∈ `vai-tro, cac-buoc, dod, cong-cu, brain, ket-noi`, `#dieu-phoi`, `#team`, `#fanpage`. `render()` dựng lại toàn bộ view hiện tại từ `ws`. Chi tiết task, giao việc, tạo agent, sửa thành viên là hộp thoại `#dlg`.

### 5.3 Dữ liệu (`ws`, trong IIFE)

| Collection | Nội dung |
| --- | --- |
| `members` | `{ id, name, role, color }`. Role bắt đầu bằng “PO” thì duyệt được mọi task |
| `agents` | `{ id, owner, template, name, mission, input, output, prompt, rules, status (nhap/thu/on), mode (buoc/auto), steps:[{id,name,review}], tools:[], customTools, criteria:[], metrics:[{id,name,target,unit,src,value}] }` |
| `tasks` | `{ id, title, desc, from, to, agentId, pageId, status, step, returns, outputs:[{step,by,at,text}], history:[{at,who,text}], dodOk, dodChecks, doneAt, parent }`. `status` ∈ `moi, dang-lam, can-sua, cho-duyet, xong` |
| `brain` | Second brain: `{ id, agentId, text, source (tra-lai/duyet/tay/agent), by, taskId, at, active }`. Bài học `active` được gửi kèm mọi task sau |
| `pages` | `{ id, name, niche, level, fbId?, acct?, demo?, researchId?, market?, language?, voice?, description?, topics:[] }`. Các trường từ research đi vào `pageProfile` của gói ngữ cảnh |
| `research` | Một đợt research cho một kênh: `{ id, market, language, seeds, sources:[], marketDone, agentId, topics:[{ id, title, summary, audience, questions, demand, growth, engagement, competition, monetization (1–5), sources, sample, at, firstAt }], pageIdeas:[{ id, name, topics, why, at }], scans:[{ taskId, at, imported, count, auto }], daily:{ on, time, tz, count }, lastAuto, plan:{ topicIds, pageName, altNames, description, category, voice, checks:[] }, pageId }` |
| `settings` | `[{ id:'main', paused }]` (dừng khẩn) |

Nguồn chỉ số (`metrics[].src`): `auto:firstpass` (task xong không bị trả lại, 10 task gần nhất), `auto:dod` (đạt đủ tiêu chí khi duyệt), `agent` (agent gửi trong `metrics` khi nộp), `tay`. Agent “sẵn sàng giảm duyệt” khi có ≥ 5 task xong và mọi chỉ số có giá trị đều đạt mục tiêu (`readiness()`).

Có server: `ws` lấy từ `/api/ws`, mỗi thay đổi gọi `put()`/`del()` lên server, kéo lại mỗi 4 giây (không vẽ lại khi đang gõ; hộp thoại task đang mở thì vẽ lại riêng nó, giữ vị trí cuộn). `liveBlock(t)` hiện ở hộp thoại task, thẻ trên bảng điều phối, thẻ “Gợi ý sáng nay”: task `dang-lam` có thanh tiến trình ước tính (theo số lần tìm và đọc web, dừng ở 92% tới khi nộp), giai đoạn, thời gian, câu đang tìm; quá 2 phút không có tin thì cảnh báo. Task `moi`/`can-sua` mà agent không hỏi việc trong 3 phút (`agentOnline()`) thì báo “chưa có agent nào đang chạy” kèm lệnh cần chạy. Không server: `localStorage['autofb-ws-v1']`, có dữ liệu mẫu (`seed(true)`). Người đang dùng lưu ở `localStorage['autofb-me']`.

### 5.4a Research (`vResearch()`)

Sáu bước trong `JOURNEY`; bước sau chỉ mở khi các bước trước xong (`stepDone()`, `journeyStep()`).

1. **Thị trường** (`MARKETS`, Mỹ có nhãn Ưu tiên): ngôn ngữ, từ khóa gợi ý.
2. **Quét chủ đề**: chọn agent `template:'research'`, nguồn (`SOURCES`: Google Trends, Reddit API, YouTube Data API, TikTok Creative Center, Meta Ad Library, page Facebook tham khảo chỉ đọc bằng tay, tìm kiếm web). Agent chỉ đọc. Task quét có bước “Tổng hợp chủ đề” cần duyệt; task xong thì `syncScans()` đọc JSON ở kết quả cuối (`importTopics()`, nhận cả `pageIdeas`). Có ô dán JSON tay và nút dữ liệu mẫu (gắn nhãn “Mẫu”). Điểm chủ đề `score()` = nhu cầu 25%, tăng trưởng 20%, tương tác 25%, cạnh tranh đảo ngược 15%, kiếm tiền 15%, thang 100.
3. **Chọn ngách**: chọn chủ đề, soạn hồ sơ page (tên, tên dự phòng, danh mục, mô tả, giọng). Có danh sách gợi ý page của agent.
4. **Tạo page thủ công**: checklist `PAGE_CHECKS`, nút sao chép, link Business Manager và tìm tên trùng. Dashboard không tự điều khiển trình duyệt.
5. **Kết nối page**: chọn page từ tài khoản Facebook đã đăng nhập, hoặc nối tạm bằng tên. `linkPage()` chép thị trường, ngôn ngữ, giọng, mô tả, chủ đề vào page; page vào ở mức 1.
6. **Build agent chức năng** (`FUNC_TPL`: nội dung, kiểm duyệt, cộng đồng): agent tạo ra có `pageId` và prompt điền sẵn thông tin page.

**Gợi ý sáng nay** (`morningCard()`): bật/tắt, giờ, số chủ đề tối đa; trạng thái lượt quét hôm nay; chủ đề mới (`firstAt` từ 0h hôm nay) và gợi ý page. Hiện ở bước Quét và ở đầu “Không gian của tôi”. “Dùng gợi ý này” điền tên page và chủ đề vào đợt hiện tại, hoặc mở đợt research mới (lịch sáng tắt) nếu đợt hiện tại đã có tên page.

**Trình bày kết quả trong hộp thoại task** (`outputView()`): kết quả là JSON có `topics` thì hiện báo cáo (`topicsReport()`): ô tóm tắt, công thức điểm, bảng xếp hạng thu gọn từng dòng (mở ra thấy 5 chỉ số dạng thanh kèm lý do, lưu ý, câu hỏi người dùng, góc bài, nguồn), thẻ gợi ý page, ghi chú. Nhãn “Theo mùa” chỉ khi `reasons.risk` bắt đầu bằng “Theo mùa” hoặc có “hết mùa”. JSON có `findings` thì hiện `findingsReport()`: nguồn đã xem hay bị hạn chế (theo `coverage`), bằng chứng gom theo `topic_hint`. JSON gốc luôn còn trong mục “Xem JSON gốc”. Mô tả task dài hơn 300 ký tự được thu gọn thành “Yêu cầu của task”.

### 5.4 Luồng task

1. Giao việc: chọn người nhận và một agent của người đó, gắn page nếu cần.
2. Agent (hoặc người, dán tay) nộp kết quả cho bước hiện tại. Bước có “Cần duyệt” và agent ở chế độ `buoc` → `cho-duyet`; không thì sang bước sau (`moi`) hoặc `xong`.
3. Người nhận (hoặc PO) duyệt hay trả lại. Trả lại bắt buộc ghi lý do; lý do thành bài học `tra-lai`. Duyệt có ghi chú thành bài học `duyet`. Bước cuối có checklist DoD. Trả quá 2 lần thì hiện cảnh báo nên tự làm hoặc sửa prompt.
4. Task xong có nút “Chuyển tiếp cho người khác”: tạo task mới với kết quả cuối làm mô tả (`parent` trỏ về task cũ).

Gói ngữ cảnh agent nhận (`packet()` ở client, `contextPacket()` ở server): thông tin agent, prompt, luật riêng, `GLOBAL_RULES`, công cụ, các bước, DoD, bài học đang dùng, task (bước hiện tại, kết quả các bước trước, ghi chú trả lại của chính task đó).

### 5.5 Quy ước giao diện

- Màu là biến CSS trên `:root`, có bộ cho `prefers-color-scheme: dark`, `:root[data-theme="dark"]`, `:root[data-theme="light"]`.
- Nhân vật agent là ô vuông màu có biểu tượng robot, màu theo chủ agent. Thành viên là vòng tròn chữ cái đầu. Không dùng khuôn mặt người thật.
- Chữ hiển thị dùng dấu nháy Việt “ ” và ’; giữ nháy thẳng trong code.
- Ghép chuỗi người dùng nhập qua `esc()` trước khi đưa vào HTML.
- Câu chữ ngắn, rõ, tiếng Việt tự nhiên; tránh thuật ngữ khi có từ thường dùng.

---

## 6. Việc cần làm tiếp (đề xuất thứ tự)

Bám theo lộ trình PRD. Mỗi bước nên kết thúc bằng thứ chạy được.

1. **Kiểm chứng với Meta (làm ngay)**
   - Webhook bình luận khi app ở chế độ phát triển có nhận bình luận của người xem thật không, hay chỉ của người có vai trò trong app.
   - Giới hạn số Reel đăng qua API mỗi ngày và giới hạn tốc độ theo page, ở phiên bản Graph hiện hành.
   - Có cách gắn nhãn AI khi đăng qua API không.
   - Có ghim bình luận qua API được không (PRD có tính năng ghim).
   - App loại Business có cần `config_id` (Facebook Login for Business) thay cho `scope` không.
2. **Đăng thử 1 bài thật mỗi page** bằng token page đã lưu (bài chữ trước, rồi ảnh, rồi Reel qua `video_reels`). Đây là tiêu chí xong tuần 1 của PRD.
3. **Chuyển lưu trữ sang Postgres**: bảng page, hồ sơ page, bài, số liệu, bình luận, log, tài khoản (token mã hóa khi lưu). Vector store cho bộ nhớ page và so trùng.
4. **Lịch chạy và hàng đợi** (cron + hàng đợi, hoặc n8n cho luồng đơn giản): tạo việc mỗi sáng, chạy theo thứ tự, thử lại khi lỗi, dừng page khi có cảnh báo, ghi log.
5. **Agent thật**: mỗi agent = prompt vai trò + công cụ (đọc/ghi bộ nhớ, tìm kiếm) + đầu ra JSON có schema. Prompt do anh Mạnh và chị Dương làm chủ, để ở `prompts/<tên>.md`, không nhúng cứng trong code. Đã có `prompts/research.md` (2 bước: “Quét nguồn” trả `findings`, “Tổng hợp chủ đề” trả `topics` có `reasons`, `angles` và `pageIdeas`; thang điểm 1–5 có mốc; ngách bị loại; tự kiểm trước khi nộp). Đã có `agents/research.js`: hỏi `/next` mỗi `POLL_SECONDS`, gọi Claude qua `@anthropic-ai/sdk` (ghim `0.135.0`) bằng `client.beta.messages.stream` với `claude-opus-5-5`, `thinking: adaptive`, `output_config.effort`, `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), system prompt có `cache_control`, công cụ `web_search_20260209` và `web_fetch_20260209` (chặn facebook.com, instagram.com, threads.net; `user_location` theo thị trường); nối tiếp khi `pause_turn` (tối đa 8 lần); kiểm tra JSON theo bước, sửa 1 lần; lỗi thì gọi `/release`. Còn thiếu prompt và chương trình chạy cho agent nội dung, kiểm duyệt, cộng đồng (thêm `promptFile` vào template tương ứng). Có `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` thì thêm công cụ chạy trên máy `reddit_search`, `reddit_comments` (OAuth app-only, chỉ đọc); có `YOUTUBE_API_KEY` thì thêm `youtube_search`, `youtube_comments`. Các công cụ này không trả tên người dùng; đầu vào được kiểm tra (`validInput`) trước khi chạy vì bật `eager_input_streaming`; vòng `ask()` chạy `tool_use` và trả mọi `tool_result` trong một tin nhắn. Chưa có Meta Ad Library API (facebook.com bị chặn với web tool). Đăng nhập Claude: `ANTHROPIC_API_KEY` hoặc hồ sơ `ant auth login` (SDK tự đọc; không để dòng `ANTHROPIC_API_KEY=` rỗng vì nó chặn hồ sơ).
6. **Kiểm duyệt hai lớp**: chấm kịch bản trước khi dựng (rẻ), chấm bản dựng sau (cần trích khung hình và transcript). Những kiểm tra quy tắc cứng (nguồn nhạc/hình qua metadata, ngưỡng tương đồng) làm bằng code, không để AI tự cảm nhận.
7. **Dựng media**: TTS, phụ đề, hình AI hoặc kho có bản quyền, render theo 2–3 mẫu mỗi page bằng ffmpeg. Lưu nguồn của mọi asset.
8. **Webhook bình luận** + agent cộng đồng thật; đăng ký `feed` cho từng page (`pages_manage_metadata`).
9. **Insights** theo lịch, bảng số liệu thật, báo cáo tuần.
10. **Nối dashboard với dữ liệu thật**: thay vòng mô phỏng bằng dữ liệu từ server (polling hoặc SSE). Giữ chế độ mô phỏng làm "demo mode" khi không có server.
11. **Bảo mật trước khi mở cho team**: đăng nhập dashboard, phân quyền theo vai trò (PO, quản lý kênh, người duyệt, chăm sóc cộng đồng, người xem số liệu), HTTPS, nút dừng khẩn tác động thật tới hàng đợi.
12. Thông báo Telegram khi có việc chuyển người hoặc dừng khẩn.

Có thể tách `public/index.html` thành nhiều file khi bắt đầu nối dữ liệu thật, nhưng giữ được giao diện và hành vi hiện tại.

---

## 7. Rủi ro và câu hỏi mở (từ phân tích PRD)

- **Dịch vụ đăng bài bên thứ 3** (ví dụ Post for Me) được đề xuất để khỏi chờ Meta duyệt app. Cách này lệch với luật “vận hành qua Graph API chính thức” ở mục 1 và 2, và token page phải giao cho bên thứ 3. Team cần chốt trước khi viết code cho hướng này.

- **Thiếu người làm kỹ thuật** trong bảng phân công, trong khi phần lớn khối lượng tháng 11 là backend (DB, hàng đợi, ffmpeg, webhook, Graph API, dashboard). Rủi ro lớn nhất cho mốc 30/11.
- **Webhook ở chế độ phát triển** có thể không nhận bình luận của người xem thật (xem mục 6.1).
- **Thiếu quyền trong PRD gốc**: cần thêm `pages_manage_metadata` (webhook), `pages_read_user_content` (đọc bình luận người dùng), `pages_show_list`. Server đã xin các quyền này.
- **Mâu thuẫn mức 2**: phản hồi bình luận < 15 phút nhưng mức 2 cho người "vài giờ để chặn". Hiện dashboard hiểu là: bài hẹn giờ, câu trả lời gửi ngay. Cần PO xác nhận.
- **Agent chiến lược cần nguồn dữ liệu cụ thể**: Facebook không cho đọc tự do số liệu page đối thủ; kiểm tra trùng thương hiệu cần tra cứu thật. Dùng tìm kiếm web, Google Trends, Meta Ad Library, hoặc Claude in Chrome (chỉ đọc).
- **Chưa có tiêu chí nghiệm thu cho agent**: bộ bài xấu cố ý để thử agent kiểm duyệt, định nghĩa "hook yếu", ngưỡng tương đồng.
- **Chưa ước tính chi phí AI** mỗi bài và mỗi page.
- **Phạm vi nút dừng khẩn** chưa rõ: một page hay toàn hệ thống, có gỡ bài đã đăng không.
- **Dữ liệu cá nhân**: đánh dấu khách tiềm năng từ bình luận là xử lý dữ liệu cá nhân; cần bên pháp chế xem quy định bảo vệ dữ liệu cá nhân ở Việt Nam.
- **Chỉ số chính dễ bị bóp méo** khi mẫu số (giờ người) quá nhỏ; không tính bình luận của chính page.
- **Kiếm tiền ở ngày 61–90** có thể lạc quan: các chương trình kiếm tiền của Facebook có ngưỡng điều kiện, có chương trình theo lời mời. Affiliate và sản phẩm công ty thực tế hơn.

---

## 8. Cài đặt và xử lý lỗi thường gặp

Cài đặt chi tiết trong `README.md`. Tóm tắt:

1. Node.js ≥ 20.6.
2. Tạo app Meta (loại Business), thêm Facebook Login, khai báo redirect URI `http://localhost:3000/auth/facebook/callback`, lấy App ID và App Secret.
3. `cp .env.example .env` (Windows: `copy .env.example .env`), điền khóa. Trên Windows chú ý Notepad hay lưu thành `.env.txt`.
4. `npm install`, `npm start`, mở http://localhost:3000. Giữ cửa sổ terminal mở.
5. Khi app chưa qua App Review, chỉ tài khoản có vai trò trong app mới đăng nhập được.

| Lỗi | Nguyên nhân và cách sửa |
| --- | --- |
| Trình duyệt báo không kết nối được localhost | Server chưa chạy hoặc đã tắt. Chạy `npm start`, chờ dòng "AUTOFB đang chạy" |
| `bad option: --env-file` | Node cũ hơn 20.6 |
| `Cannot find package 'express'` | Chưa `npm install` hoặc đứng sai thư mục |
| `Thiếu FB_APP_ID hoặc FB_APP_SECRET` | Chưa có `.env` hoặc chưa điền |
| `ENOENT ... package.json` | Chưa `cd autofb` |
| `EADDRINUSE :3000` | Cổng bận. Đổi `PORT` và `BASE_URL`, sửa redirect URI trong app Meta cho khớp |
| Facebook báo URL không hợp lệ | Redirect URI trong app Meta khác `BASE_URL/auth/facebook/callback` |
| Đăng nhập xong nhưng 0 page | Tài khoản không quản trị page nào, hoặc chưa tick page khi cấp quyền, hoặc page nằm trong BM mà app chưa được cấp quyền |

---

## 9. Cách làm việc với dự án này

- Trước khi sửa, đọc mục 2 (luật bắt buộc). Nếu task mâu thuẫn với luật, dừng và hỏi.
- Không commit `.env`, `data/`, token, App Secret.
- Mọi lời gọi Graph API: ghim phiên bản qua `GRAPH_VERSION`, xử lý lỗi và giới hạn tốc độ, thử lại có giãn cách, ghi log.
- Giữ chế độ mô phỏng chạy được khi không có server, để bản xem trước trên claude.ai vẫn dùng được.
- Câu chữ giao diện bằng tiếng Việt, ngắn và rõ. Kiểm tra cả giao diện sáng và tối, màn hình hẹp (điện thoại) và rộng.
- Thư viện mới: ghim phiên bản chính xác, chọn bản đã phát hành ít nhất hai tuần, chạy `npm audit`.
