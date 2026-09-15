# agentpager

Điều khiển agent lập trình trên máy (hiện tại: Claude Code) từ xa qua một bot Telegram riêng.

| Thư mục | Nội dung |
|---|---|
| [`packages/core`](packages/core) | Bot, daemon và lệnh `agentpager` — gói npm [`@chiennguyen/agentpager`](https://www.npmjs.com/package/@chiennguyen/agentpager). Cài đặt và sử dụng: [packages/core/README.md](packages/core/README.md). |
| [`apps/desktop`](apps/desktop) | agentpager app (Windows, macOS): thiết lập, chạy, xem trạng thái, người dùng, cài đặt và log không cần terminal; tự cập nhật trên Windows. Tải bộ cài ở [Releases](https://github.com/nguyenkechien/agentpager/releases), hướng dẫn trong [apps/desktop/README.md](apps/desktop/README.md). |

## Phát triển

```bash
npm install
npm run check   # build core, rồi typecheck + lint + test mọi workspace
npm run build
```

Thiết kế: `docs/superpowers/specs/`. Giấy phép MIT.
