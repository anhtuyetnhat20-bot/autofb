# AUTOFB

Nơi mỗi người trong team build agent của riêng mình và giao việc cho nhau. Kèm một server nhỏ để lưu dữ liệu chung, cho agent trên máy từng người lấy việc và nộp kết quả, **đăng nhập Facebook thật** và **lấy danh sách page thật** qua Graph API.

## Dùng thế nào

Làm theo thứ tự: Research trước, agent chức năng sau.

- **Research thị trường** (6 bước): chọn thị trường (ưu tiên Mỹ) → agent research quét và social listening tìm chủ đề người dùng quan tâm → chọn ngách, soạn hồ sơ page → tạo page thủ công trên Facebook → kết nối page → build agent nội dung, kiểm duyệt, cộng đồng cho page đó.
- **Gợi ý sáng nay**: 8h30 mỗi sáng (giờ Việt Nam), server tự giao cho agent research một lượt quét. Agent nộp chủ đề mới và 2–3 gợi ý page; bạn duyệt là gợi ý hiện ở đầu trang. Cần server đang chạy lúc đó và agent research trên máy người phụ trách đang chờ việc.
- **Không gian của tôi**: agent bạn đang build, task chờ bạn duyệt, task giao cho bạn, bài học mới nhất.
- **Agent của tôi**: mỗi agent có vai trò và prompt, các bước làm và bước nào cần duyệt, định nghĩa “xong” kèm chỉ số, công cụ, second brain, và cách nối agent trên máy vào hệ thống.
- **Bảng điều phối**: mọi task của team theo cột Mới, Đang làm, Cần sửa, Chờ duyệt, Xong. Lọc theo người.
- Khi bạn trả lại hay duyệt có ghi chú, lý do tự vào second brain của agent và được gửi kèm các task sau.

## Phần nào thật, phần nào chưa có

| Phần | Trạng thái |
| --- | --- |
| Thành viên, agent, task, second brain, dừng khẩn | Thật, lưu chung trong `data/workspace.json` |
| Agent trên máy lấy task (`GET /api/agents/<id>/next`) và nộp kết quả (`POST /api/tasks/<id>/result`) | Thật |
| Đăng nhập Facebook, lấy danh sách page | Thật, khi đã điền khóa app Meta |
| Agent research tự làm việc | Có chương trình `agents/research.js` (Claude + tìm kiếm và đọc web). Cần khóa API Anthropic |
| Agent nội dung, kiểm duyệt, cộng đồng | Chưa có chương trình chạy; người phụ trách tự chạy trên máy (Claude Code, script, n8n…) gọi hai lệnh trên |
| Đăng bài, trả lời bình luận, số liệu qua Graph API | Chưa có |

Mở `public/index.html` mà không chạy server thì dashboard dùng dữ liệu mẫu, lưu trên trình duyệt, chỉ để xem thử.

**Chưa có đăng nhập cho dashboard.** Ai mở cũng chọn được tên bất kỳ. Server chỉ nghe trên máy chạy nó; đừng mở ra mạng ngoài trước khi có đăng nhập và HTTPS.

## Cài đặt

### 1. Chuẩn bị

Cần Node.js 20.6 trở lên.

### 2. Tạo app trên Meta

1. Vào developers.facebook.com, tạo app mới, chọn loại Doanh nghiệp (Business). Nên gắn app vào Business Manager riêng của hệ thống, đúng như PRD.
2. Thêm sản phẩm **Facebook Login** (hoặc **Facebook Login for Business**).
3. Trong phần cài đặt của Facebook Login, thêm vào **Valid OAuth Redirect URIs**:
   `http://localhost:3000/auth/facebook/callback`
4. Vào Cài đặt ứng dụng, mục Thông tin cơ bản, lấy **App ID** và **App Secret**.
5. Nếu dùng Facebook Login for Business: tạo một Configuration, chọn các quyền ở bảng dưới, lấy **Configuration ID**.

Quyền app xin:

| Quyền | Dùng để |
| --- | --- |
| `pages_show_list` | Liệt kê page tài khoản quản trị |
| `pages_read_engagement` | Đọc thông tin page, số theo dõi, bài viết |
| `pages_manage_posts` | Đăng bài |
| `pages_manage_engagement` | Trả lời, ẩn bình luận |
| `pages_read_user_content` | Đọc bình luận của người xem |
| `pages_manage_metadata` | Đăng ký webhook |
| `read_insights` | Số liệu page |
| `business_management` | Page nằm trong Business Manager |

### 3. Cấu hình và chạy

```bash
cp .env.example .env      # rồi điền FB_APP_ID, FB_APP_SECRET (và FB_CONFIG_ID nếu có)
npm install
npm start
```

Chưa có khóa app Meta thì vẫn chạy được: server bỏ qua phần Facebook, các phần còn lại dùng bình thường.

Mở http://localhost:3000, chọn tên của bạn ở góc phải trên. Để nối Facebook: vào **Fanpage**, bấm **Đăng nhập với Facebook**. Một tab mới mở trang của Facebook; đăng nhập và cấp quyền xong, tab tự đóng và dashboard hiện danh sách page.

## Chạy agent research

Agent research chạy trên máy người phụ trách, cạnh server. Nó hỏi server có task quét không, gọi Claude để tìm và đọc web theo prompt trong `prompts/research.md`, rồi nộp kết quả về dashboard.

1. Đăng nhập Claude, chọn một trong hai cách:
   - **Không cần chép khóa:** cài công cụ `ant` của Anthropic (bản Windows ở github.com/anthropics/anthropic-cli/releases), chạy `ant auth login`, đăng nhập trong trình duyệt. Agent tự dùng phiên đăng nhập này. Phiên hết hạn thì chạy lại lệnh.
   - **Bằng khóa API:** lấy khóa ở console.anthropic.com → API Keys, mở `.env`, thêm dòng `ANTHROPIC_API_KEY=` rồi dán khóa vào sau dấu bằng.
2. Không bắt buộc: điền `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`, `YOUTUBE_API_KEY` vào `.env` (cách lấy ghi trong `.env.example`). Có khóa thì agent đọc Reddit và YouTube qua API chính thức: tìm bài, đọc bình luận nổi bật, xem lượt xem so với số người đăng ký. Công cụ không trả tên người dùng.
3. Giữ server đang chạy (`npm start`), mở thêm một cửa sổ terminal trong thư mục `autofb` và chạy:

```bash
npm run agent:research
```

Cửa sổ này phải mở lúc 8h30 thì lượt quét buổi sáng mới chạy. Muốn chạy một lượt rồi thoát: `npm run agent:research -- --once`.

**Tự chạy khi bật máy (Windows):** chạy một lần lệnh dưới đây. Nó tạo lối tắt AUTOFB trong thư mục Startup; mỗi lần đăng nhập Windows, server và agent research tự bật trong hai cửa sổ thu nhỏ (cái nào đang chạy rồi thì bỏ qua). Không cần quyền quản trị.

```bash
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

Gỡ: thêm `-Remove` vào cuối lệnh. Máy ngủ lúc 8h30 thì lượt quét được giao bù khi máy thức.

Cách chương trình làm việc:

- Dùng mô hình `claude-opus-5-5` (đổi bằng `RESEARCH_MODEL`), suy nghĩ thích ứng, mức `high` (đổi bằng `RESEARCH_EFFORT`).
- Chỉ có hai công cụ: tìm kiếm web và đọc trang công khai. Facebook, Instagram, Threads bị chặn. Vị trí tìm kiếm đặt theo thị trường (Mỹ → US).
- Bật dự phòng phía server (`fallbacks: "default"`): khi bộ lọc an toàn từ chối, API tự chạy lại trên mô hình dự phòng trong cùng lượt.
- Kiểm tra JSON trước khi nộp: đúng cấu trúc của bước, điểm là số nguyên 1–5, gợi ý page chỉ nhắc chủ đề có trong danh sách. Sai thì nhờ Claude sửa một lần.
- Lỗi (từ chối, quá dài, JSON hỏng, lỗi API) thì trả task về. Lỗi 3 lần, task bị khóa và hiện nhãn “Agent lỗi”; bấm “Cho chạy lại” trong task khi đã xử lý.
- Mỗi lượt in số token để theo dõi chi phí.

## Lưu ý quan trọng

**Chế độ phát triển.** Khi app chưa qua App Review, chỉ những tài khoản có vai trò trong app (quản trị viên, nhà phát triển, người thử nghiệm) mới đăng nhập và cấp quyền được. Thêm tài khoản của team trong mục Vai trò của app. Muốn dùng rộng hơn cần App Review và xác minh doanh nghiệp.

**Phiên bản Graph API.** `GRAPH_VERSION` mặc định là `v23.0`. Kiểm tra phiên bản mới nhất trong App Dashboard và cập nhật trong `.env`, vì Meta ngừng hỗ trợ các phiên bản cũ theo lịch.

**Bảo mật token.** `data/store.json` chứa token truy cập của tài khoản và page. Không gửi file này cho ai, không đưa lên Git (đã có trong `.gitignore`). Server chỉ nghe trên `127.0.0.1`; trước khi mở cho mạng ngoài cần thêm đăng nhập cho dashboard và chạy qua HTTPS.

**Token lâu dài.** Server đổi token ngắn hạn sang token dài hạn (khoảng 60 ngày). Để vận hành ổn định theo PRD, nên chuyển sang token System User của Business Manager.

## Tạo page mới bằng Claude trong Chrome

Graph API không cho tạo page mới, nên việc này làm trên trình duyệt:

1. Cài tiện ích Claude in Chrome trên máy vận hành.
2. Agent chiến lược (bật công cụ **Claude in Chrome, chỉ đọc**) nộp tên, mô tả, danh mục cho page trong kết quả task.
3. Mở Claude in Chrome, đưa phần đã soạn và cùng tạo page. Bạn theo dõi và xác nhận từng bước.
4. Quay lại dashboard, vào **Fanpage**, bấm **Quét lại** ở tài khoản tương ứng rồi **Thêm** page mới.

Dashboard không tự điều khiển Chrome; quyền dùng trình duyệt do bạn cấp và kiểm soát trong tiện ích Claude in Chrome. Việc đăng bài, bình luận hằng ngày vẫn đi qua Graph API, không chạy tự động bằng trình duyệt.

## Cài đặt nhanh (bản 11/2026)

1. Node.js 22+, FFmpeg (`winget install Gyan.FFmpeg`), Python 3.12 (`winget install Python.Python.3.12`).
2. `py -3.12 -m pip install kokoro-onnx soundfile numpy` (giọng đọc AI). Lỗi DLL thì cài `winget install Microsoft.VCRedist.2015+.x64`.
3. Trong thư mục dự án: `npm install` rồi `npm install hyperframes@0.9.59`.
4. Sao chép `.env.example` thành `.env`, điền FB_APP_ID, FB_APP_SECRET, MUSE_API_KEY, MUSE2API_BASE.
5. `npm start`, mở http://localhost:3000.

Không đưa `.env` và thư mục `data/` lên GitHub: chứa token Facebook, key và dữ liệu page.
