# Changelog — agentpager app

Phiên bản của app desktop (tag `vX.Y.Z` trên GitHub Releases). agentpager cli có changelog riêng trong `packages/core/CHANGELOG.md`.

## 0.1.0 — 2026-09-15

- Bản cài đặt đầu tiên: bộ cài Windows (`agentpager-Setup-0.1.0.exe`, cài cho user hiện tại, không cần quyền admin) và file `.dmg` cho macOS Apple Silicon và Intel.
- Windows tự tải bản mới và hiện nút "Cập nhật"; bot chỉ dừng khi bạn bấm. Nếu agent đang chạy lượt hoặc còn tin chờ, app hỏi trước và có thể đợi agent rảnh rồi mới cài. Cài xong app tự mở lại và chạy lại bot.
- macOS báo khi có bản mới và mở trang tải.
- Icon mới (máy nhắn tin); icon khay có chấm màu trạng thái, hợp với taskbar/thanh menu sáng và tối.
- Chuyển bot đang chạy bằng agentpager cli sang app bằng một nút ở màn Trạng thái.
- Gỡ cài đặt: tắt tự khởi động và icon khay khi đăng nhập nếu trỏ tới app, giữ nguyên cấu hình và log của bot. macOS có nút gỡ trong Cài đặt và hỏi chuyển app vào Applications.
- Cần agentpager core 0.1.3 (đi kèm app).
