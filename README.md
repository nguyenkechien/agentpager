# agentpager

Điều khiển agent lập trình trên máy (hiện tại: Claude Code) từ xa qua một bot Telegram riêng.

| Thư mục | Nội dung |
|---|---|
| [`packages/core`](packages/core) | Bot, daemon và lệnh `agentpager` — gói npm [`@chiennguyen/agentpager`](https://www.npmjs.com/package/@chiennguyen/agentpager). Cài đặt và sử dụng: [packages/core/README.md](packages/core/README.md). |
| `apps/desktop` | App desktop (Windows, macOS) — đang phát triển. |

## Phát triển

```bash
npm install
npm run check   # build core, rồi typecheck + lint + test mọi workspace
npm run build
```

Thiết kế: `docs/superpowers/specs/`. Giấy phép MIT.
