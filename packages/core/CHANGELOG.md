# Changelog

## 0.1.2 — 2026-09-14

- `agentpager autostart on|off` từ chối khi đặt `AGENTPAGER_HOME`, và `setup` bỏ qua bước tự khởi động: task Task Scheduler / LaunchAgent là thiết lập chung của máy và không mang theo thư mục đó (trước đây sẽ ghi đè tự khởi động của bot chính).
- Mỗi `AGENTPAGER_HOME` có named pipe IPC riêng trên Windows; trước đây daemon ở thư mục khác đụng pipe của bot chính và thoát ngay.
- Lỗi lúc daemon khởi động được ghi vào `logs/supervisor.log` (ghi đồng bộ, không mất dòng cuối khi tiến trình thoát).
- `agentpager autostart status` / `status`: cảnh báo đường dẫn không còn tồn tại có dạng chung "Không còn tìm thấy …" kèm một dòng hướng dẫn sửa.
- Task tự khởi động ghi mọi tham số trong dấu ngoặc kép; task do 0.1.1 tạo vẫn đọc được.
- `daemon.json` ghi nguồn chạy (`launcher`: `cli` hoặc `app`).
- Gói có thêm entry point cho app desktop: `@chiennguyen/agentpager/{config,control,daemon,platform,providers}` (kèm type declarations).

## 0.1.1 — 2026-09-14

- Hỗ trợ Node ≥ 22.

## 0.1.0 — 2026-09-14

- Bản đầu tiên: bot Telegram điều khiển Claude Code, daemon chạy nền, lệnh `agentpager`, tự khởi động trên Windows và macOS.
