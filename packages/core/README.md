# agentpager

Điều khiển agent lập trình trên máy (hiện tại: **Claude Code**) từ xa qua một bot Telegram riêng — cho những lúc cần xử lý gấp mà không ngồi trước máy. Chạy nền trên **Windows** và **macOS**, quản lý bằng lệnh `agentpager`.

- Giữ ngữ cảnh session giữa các tin nhắn; phiên tự kết thúc sau 60 phút không hoạt động (tuỳ chỉnh được).
- `/new`, `/history`, `/resume`, `/project`, `/stop`, `/status`, `/model`, `/usage`.
- Gửi ảnh/file cho agent; agent gửi file về qua tool `send_file`.
- Câu hỏi nhiều lựa chọn và yêu cầu xin quyền của agent hiện thành nút bấm.
- Agent chạy **full quyền**, có một lớp guard chặn vài lệnh thảm hoạ.
- Whitelist theo **@username**: tin nhắn riêng đầu tiên từ username đó sẽ gắn user ID; từ đó chỉ ID được tin.

## ⚠️ Bảo mật — đọc trước

- Ai điều khiển được bot = chạy được lệnh bất kỳ trên máy này. Bot chỉ nhận tin trong chat riêng từ người dùng trong danh sách; người khác nhắn sẽ không nhận được phản hồi nào.
- **Bật xác minh 2 bước cho tài khoản Telegram** (Settings → Privacy and Security → Two-Step Verification). Mất tài khoản Telegram = mất quyền kiểm soát máy.
- Username Telegram có thể đổi chủ. Sau khi ghép, bot chỉ tin **user ID**; nếu username đã ghép với ID khác nhắn tới, bot từ chối và ghi log cảnh báo.
- Guard chỉ là lưới an toàn thô (regex), **không phải ranh giới bảo mật** — có thể bị lách và có thể chặn nhầm.
- Token bot nằm trong `config.json` ở thư mục app-data của user (quyền `0600` trên macOS). Đừng chia sẻ file đó.

## Cài đặt

Cần Node.js ≥ 22 và Claude Code CLI đã đăng nhập (`claude` chạy được một lần).

```bash
npm install -g @chiennguyen/agentpager
agentpager setup
```

> Gói npm có tên `@chiennguyen/agentpager` (tên `agentpager` bị npm từ chối vì quá giống một gói khác); lệnh vẫn là `agentpager`.
>
> Không muốn dùng terminal? Có [app desktop](../../apps/desktop) (Windows, macOS) làm cùng việc này.
>
> Cài từ mã nguồn: ở thư mục gốc repo chạy `npm install`, `npm run build -w packages/core`, rồi `npm link` trong `packages/core` để có lệnh `agentpager` trong mọi terminal (gỡ: `npm unlink -g @chiennguyen/agentpager`). Lệnh `agentpager` dùng Node đang có trong terminal; nếu dùng fnm/nvm, chạy lại `agentpager autostart on` sau khi đổi phiên bản Node mặc định để task tự khởi động trỏ đúng Node.
>
> Trong PowerShell không có `head`: dùng `agentpager logs | Select-Object -First 20`.

`agentpager setup` hỏi lần lượt:

1. **Bot token** — tạo bot qua [@BotFather](https://t.me/BotFather) (`/newbot`); token được kiểm tra với Telegram.
2. **Username** được dùng bot (vd: `@alice, @bob`).
3. **Thư mục chứa các project** (mặc định `D:\Projects` trên Windows / `~/Projects` trên macOS nếu có).
4. **Agent** và đường dẫn CLI (tự dò; Enter để dùng).
5. Số phút không hoạt động trước khi kết thúc phiên.

Sau đó có thể bật tự khởi động và chạy luôn. Nhắn một tin bất kỳ cho bot từ mỗi username để ghép tài khoản.

## Lệnh `agentpager`

| Lệnh | Tác dụng |
|---|---|
| `setup` | Cấu hình lần đầu hoặc làm lại |
| `start [--foreground]` | Chạy nền (không có cửa sổ); `--foreground` chạy trong terminal hiện tại, Ctrl+C để dừng |
| `stop` / `restart` | Dừng / khởi động lại (áp dụng cấu hình mới) |
| `status` | Daemon, bot, agent, người dùng, tự khởi động, đường dẫn cấu hình và log |
| `logs [-f] [-n <số dòng>]` | Xem log của bot; `-f` theo dõi liên tục |
| `autostart on\|off\|status` | Tự khởi động khi đăng nhập |
| `config path\|show\|set <khoá> <giá trị>` | Xem/sửa cấu hình (token được che khi hiển thị) |
| `users list\|add <@u>\|remove <@u>\|unpair <@u>` | Quản lý người dùng; bot đang chạy cập nhật ngay |

Khoá `config set`: `telegram.botToken`, `projectsRoot`, `idleTimeoutMinutes`, `logLevel`, `agent.provider`, `agent.executable`, `agent.defaultModel`, `agent.defaultEffort` (`default` để bỏ).

## Tự khởi động

- **Windows**: `agentpager autostart on` tạo task `agentpager` trong Task Scheduler, chạy lúc bạn đăng nhập qua `conhost.exe --headless` nên không hiện cửa sổ. Bot chỉ chạy **sau khi đăng nhập**: nếu Windows Update tự khởi động lại mà chưa ai đăng nhập, bot sẽ offline — đặt **Active hours** và tắt Sleep khi cắm điện.
- **macOS**: tạo LaunchAgent `~/Library/LaunchAgents/io.github.nguyenkechien.agentpager.plist` (chạy khi đăng nhập). Tắt ngủ máy nếu cần bot luôn online.
- Lệnh được ghi lại là đường dẫn `node` và `agentpager` tại thời điểm bật. Nâng cấp Node (vd. qua nvm) thì chạy lại `agentpager autostart on`; `agentpager status` sẽ cảnh báo khi đường dẫn không còn.

Khi đặt `AGENTPAGER_HOME`, `agentpager autostart on|off` từ chối và `setup` bỏ qua bước tự khởi động: task/LaunchAgent là thiết lập chung của máy và không mang theo thư mục đó.

Daemon tự khởi động lại bot khi bot crash (5 giây → tối đa 5 phút) và dừng hẳn khi cấu hình sai (xem `agentpager status` / `logs`).

## Lệnh trong Telegram

| Lệnh | Tác dụng |
|---|---|
| `/new` | Tin nhắn tiếp theo mở phiên mới (cùng project) |
| `/history` | Session gần nhất tạo từ bot, bấm để vào lại; nút chuyển sang mọi session của project |
| `/resume` | Như `/history`; hoặc `/resume <id hoặc ≥ 8 ký tự đầu>` |
| `/project` | Chọn thư mục làm việc trong thư mục project (đổi project sẽ kết thúc phiên) |
| `/stop` | Dừng lượt đang chạy, huỷ câu hỏi đang chờ, bỏ hàng đợi |
| `/status` | Agent, project, session, trạng thái, hàng đợi, thời gian còn lại, model |
| `/model` | Chọn model và effort của agent, áp dụng từ tin sau |
| `/usage` | % đã dùng limit 5 giờ / 7 ngày / theo model và giờ reset |

Nhắn khi agent đang chạy → tin được xếp hàng (tối đa 10). Khi agent đang hỏi, tin nhắn chữ được coi là câu trả lời.

### Limit của gói Claude

- ⚠️ Server báo sắp chạm limit → bot nhắn cảnh báo (mỗi ngưỡng một lần).
- ⛔ Hết limit → bot báo loại limit và giờ reset, huỷ hàng đợi, giữ session; tin mới bị chặn tới giờ reset. Limit riêng theo model không chặn — dùng `/model` đổi model.
- ✅ Tới giờ reset → bot tự nhắn (kể cả sau khi khởi động lại).

## Dữ liệu và log

Thư mục app-data: Windows `%APPDATA%\agentpager`, macOS `~/Library/Application Support/agentpager` (đặt `AGENTPAGER_HOME` để đổi).

| File | Nội dung |
|---|---|
| `config.json` | Cấu hình (token, người dùng, agent…) |
| `state.json` | Trạng thái chat và danh sách session |
| `daemon.json` | pid, địa chỉ IPC và token điều khiển của daemon đang chạy |
| `guard-rules.json` | Tuỳ chọn: thay bộ luật guard mặc định |
| `uploads/` | File gửi từ Telegram |
| `logs/` | `agentpager.*.log` (xoay theo ngày, giữ 14 file), `supervisor.log` |

Session Claude vẫn lưu ở `~/.claude/projects` như bình thường nên có thể mở lại trên máy bằng `claude --resume <id>`.

## Agent (provider)

Phần lõi không phụ thuộc agent cụ thể: mỗi agent là một provider khai báo khả năng của mình (dừng lượt, hỏi đáp bằng nút, xin quyền, liệt kê session, guard lệnh, gửi file, ảnh, usage). Tính năng nào provider không hỗ trợ sẽ tự ẩn hoặc báo rõ trong bot. Hiện có `claude-code`; Codex, Cursor, Gemini… có thể thêm sau.

## Phát triển

Từ thư mục gốc repo (npm workspaces):

```bash
npm run check                    # build core, rồi typecheck + lint + test mọi workspace
npm run dev -w packages/core     # chạy daemon trong terminal từ mã nguồn (tsx)
npm run build -w packages/core
```

Thiết kế: `docs/superpowers/specs/2026-09-14-agentpager-core-design.md`. Giấy phép MIT.
