# agentpager desktop

App Electron cho Windows và macOS: nằm ở khay hệ thống / thanh menu, có cửa sổ **Trạng thái · Người dùng · Cài đặt · Log** và wizard thiết lập lần đầu. App tự chứa bản core của agentpager và chạy bot bằng Node đi kèm Electron — không cần cài Node/npm.

- Bot chạy trong một tiến trình riêng (`agentpager --daemon`), nên đóng cửa sổ hay "Thoát app" **không** dừng bot.
- Dùng chung thư mục app-data với lệnh `agentpager` (`%APPDATA%\agentpager`, `~/Library/Application Support/agentpager`): app và CLI thấy cùng cấu hình, cùng bot đang chạy.
- "Tự khởi động bot khi đăng nhập" đăng ký chính app (`<app> --daemon`) vào Task Scheduler / LaunchAgent. Nếu trước đó đã bật bằng CLI, màn Trạng thái đề nghị chuyển sang app.
- Lỗi của app (không phải của bot) ghi vào `logs/desktop.log`.

Chưa có bộ cài (.exe/.dmg), chữ ký số hay tự cập nhật — đó là sub-project C.

## Phát triển

Chạy từ thư mục gốc repo:

```bash
npm install
npm run build -w packages/core     # app dùng bản build của core
npm run dev -w apps/desktop        # electron-vite, renderer hot reload
npm run check -w apps/desktop      # typecheck + lint + vitest (main + renderer)
npm run pack -w apps/desktop       # build + electron-builder --dir → apps/desktop/release/
npx playwright test                # (trong apps/desktop) smoke trên bản đã pack
```

Smoke test và mọi lần chạy thử nên đặt `AGENTPAGER_HOME` sang thư mục tạm để không đụng bot thật; mỗi `AGENTPAGER_HOME` có pipe IPC riêng.

Cấu trúc: `src/main` (tiến trình chính: daemon, service, IPC, tray, cửa sổ), `src/preload` (cầu `window.agentpager`), `src/renderer` (React), `src/shared` (kiểu dữ liệu và tên kênh dùng chung). Thiết kế: `docs/superpowers/specs/2026-09-14-agentpager-desktop-design.md`.
