# agentpager

Điều khiển Claude Code (CLI cài trên máy này) từ xa qua một bot Telegram riêng — dùng cho các tình huống khẩn cấp khi không ngồi trước máy.

- Giữ ngữ cảnh session giữa các tin nhắn; phiên tự kết thúc sau 60 phút không hoạt động.
- `/new`, `/history`, `/history all`, `/resume`, `/project`, `/stop`, `/status`, `/model`.
- Gửi ảnh/file cho Claude; Claude gửi file về qua tool `send_file`.
- Câu hỏi nhiều lựa chọn của Claude (`AskUserQuestion`) và các yêu cầu xin quyền hiện thành nút bấm.
- Claude chạy **full quyền** (`bypassPermissions`), có một hook chặn vài lệnh thảm hoạ.

## ⚠️ Bảo mật — đọc trước

- Ai điều khiển được bot = chạy được lệnh bất kỳ trên máy này. Bot **chỉ** nhận tin từ `ALLOWED_USER_IDS`, trong chat riêng; người khác nhắn sẽ không nhận được phản hồi nào.
- **Bật xác minh 2 bước cho tài khoản Telegram** (Settings → Privacy and Security → Two-Step Verification). Mất tài khoản Telegram = mất quyền kiểm soát máy.
- `guard-rules.json` chỉ là lưới an toàn thô (regex), **không phải ranh giới bảo mật** — có thể bị lách, và có thể chặn nhầm (ví dụ `echo shutdown`).
- Không commit `.env`.

## Cài đặt

1. Tạo bot: nhắn [@BotFather](https://t.me/BotFather) → `/newbot` → lấy token.
2. Lấy user id của bạn: nhắn [@userinfobot](https://t.me/userinfobot).
3. Tạo cấu hình:
   ```powershell
   Copy-Item .env.example .env
   notepad .env   # điền TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, kiểm tra CLAUDE_EXECUTABLE
   ```
4. Cài và build:
   ```powershell
   npm install
   npm run build
   ```
5. Chạy thử: `npm start`, rồi nhắn `/help` cho bot.

## Tự khởi động sau khi đăng nhập Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
Start-ScheduledTask -TaskName claude-pager   # chạy ngay, không cần đăng xuất
```

- Task chạy `scripts\run.ps1` ẩn, tự khởi động lại bot nếu bot crash (backoff 5 giây → tối đa 5 phút).
- Gỡ: `powershell -ExecutionPolicy Bypass -File scripts\uninstall-task.ps1`.
- Bot chỉ chạy **sau khi bạn đăng nhập**. Nếu máy tự khởi động lại (Windows Update) mà chưa ai đăng nhập, bot sẽ offline. Giảm rủi ro: Settings → Windows Update → Advanced options → **Active hours**, và bật thông báo trước khi restart.
- Tắt Sleep/Hibernate khi cắm điện (Settings → System → Power), nếu không bot offline khi máy ngủ.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `/new` | Tin nhắn tiếp theo mở phiên mới (cùng project) |
| `/history` | 10 session gần nhất tạo từ bot, bấm để vào lại |
| `/history all` | Mọi session của project hiện tại trên máy (kể cả mở từ desktop/terminal; ⚠️ = vừa sửa trong 5 phút, có thể đang mở ở nơi khác) |
| `/resume` | Như `/history`; hoặc `/resume <id hoặc ≥8 ký tự đầu>` |
| `/project` | Chọn thư mục làm việc trong `PROJECTS_ROOT` (đổi project sẽ kết thúc phiên) |
| `/stop` | Dừng lượt đang chạy, huỷ câu hỏi đang chờ, bỏ hàng đợi |
| `/status` | Project, session, trạng thái, hàng đợi, thời gian còn lại, model, chi phí ước tính |
| `/model` | Chọn model (opus/sonnet/haiku) và effort, áp dụng từ tin sau |
| `/usage` | % đã dùng limit 5 giờ / 7 ngày / theo model + giờ reset (dùng API experimental của SDK; lỗi thì chỉ báo "không lấy được") |

### Limit của gói Claude

- ⚠️ Khi server báo sắp chạm limit trong lúc Claude chạy → bot nhắn cảnh báo (mỗi ngưỡng 1 lần).
- ⛔ Khi hết limit → bot báo loại limit + giờ reset, huỷ hàng đợi, giữ session; tin nhắn mới bị chặn tới giờ reset. Limit riêng theo model (Opus/Sonnet 7 ngày) không chặn — dùng `/model` đổi model.
- ✅ Đến giờ reset → bot tự nhắn "Limit đã reset" (kể cả sau khi bot khởi động lại).
- ⏳ API quá tải / 429 đang retry → bot báo (tối đa 1 lần/phút).

Nhắn khi Claude đang chạy → tin được xếp hàng (tối đa 10). Khi Claude đang hỏi, tin nhắn chữ được coi là câu trả lời.

## Vận hành

- Log: `logs/claude-pager.*.log` (xoay vòng theo ngày, giữ 14 file), supervisor: `logs/supervisor.log`.
- Trạng thái: `data/state.json`; file gửi lên: `data/uploads/<yyyymmdd>/`.
- Session Claude vẫn lưu ở `~/.claude/projects` như bình thường nên có thể mở lại trên máy bằng `claude --resume <id>`.

## Phát triển

```powershell
npm run check   # typecheck + lint + test
npm run dev     # chạy trực tiếp từ src bằng tsx
```

Thiết kế: `docs/superpowers/specs/2026-09-14-claude-pager-design.md`.
