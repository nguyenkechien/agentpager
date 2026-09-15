# agentpager app

App Electron cho Windows và macOS: nằm ở khay hệ thống / thanh menu, có cửa sổ **Trạng thái · Người dùng · Cài đặt · Log** và wizard thiết lập lần đầu. App tự chứa bản core của agentpager và chạy bot bằng Node đi kèm Electron — không cần cài Node/npm.

- Bot chạy trong một tiến trình riêng (`agentpager --daemon`), nên đóng cửa sổ hay "Thoát app" **không** dừng bot.
- Dùng chung thư mục app-data với agentpager cli (`%APPDATA%\agentpager`, `~/Library/Application Support/agentpager`): app và cli thấy cùng cấu hình, cùng bot đang chạy.
- "Tự khởi động bot khi đăng nhập" đăng ký chính app (`<app> --daemon`) vào Task Scheduler / LaunchAgent. Nếu trước đó đã bật bằng cli, màn Trạng thái đề nghị chuyển sang app.
- Lỗi của app (không phải của bot) ghi vào `logs/desktop.log`.

## Tải và cài

Tải ở [GitHub Releases](https://github.com/nguyenkechien/agentpager/releases). Bộ cài **chưa ký số** (dự án cá nhân, không mua chứng chỉ), nên lần đầu hệ điều hành sẽ cảnh báo.

### Windows

1. Tải `agentpager-Setup-<phiên bản>.exe` và chạy.
2. SmartScreen hiện "Windows protected your PC" → bấm **More info** → **Run anyway**.
3. Bộ cài không hỏi gì: app cài cho user hiện tại vào `%LOCALAPPDATA%\Programs\agentpager` (không cần quyền admin), tạo shortcut ở Start Menu và Desktop rồi mở app.

### macOS

1. Tải file `.dmg` đúng chip: `agentpager-<phiên bản>-arm64.dmg` (Apple Silicon: M1 trở lên) hoặc `agentpager-<phiên bản>-x64.dmg` (Intel). Xem chip ở  → About This Mac.
2. Mở `.dmg`, kéo **agentpager** vào **Applications**. Nếu mở app ngay từ `.dmg` hay Downloads, app sẽ hỏi chuyển vào Applications; tự khởi động bot chỉ bật được khi app nằm trong Applications.
3. Lần đầu mở, macOS báo "Apple could not verify agentpager…": vào **System Settings → Privacy & Security**, kéo xuống bấm **Open Anyway**, rồi mở lại app. Hoặc chạy trong Terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/agentpager.app
   ```

Đã dùng agentpager cli trước đó? App đọc luôn cấu hình cũ (không chạy wizard). Bot đang chạy bằng cli thì màn Trạng thái có nút **Chạy bot bằng app này**; tự khởi động đang trỏ tới cli thì có nút **Chuyển tự khởi động sang app này**.

## Cập nhật

- **Windows**: app tự kiểm tra bản mới (lúc mở và mỗi 6 giờ), tải ngầm, rồi hiện "Có bản mới" với nút **Cập nhật** (cả trong menu khay). Bot chỉ dừng khi bạn bấm. Nếu agent đang chạy lượt hoặc còn tin chờ, app hỏi: **Cập nhật khi rảnh** (tự cài khi agent xong việc), **Cập nhật ngay** (dừng lượt đang chạy, session vẫn giữ) hoặc **Huỷ**. Cài xong app tự mở lại và chạy lại bot; tự khởi động giữ nguyên.
- **macOS**: app báo khi có bản mới, nút **Tải bản mới** mở trang tải. Tải `.dmg` mới và kéo đè vào Applications (thoát app trước; bot vẫn chạy bản cũ tới khi bấm Restart).
- Cài đặt → **Phiên bản** cho biết bản đang dùng, trạng thái kiểm tra và nút **Kiểm tra cập nhật**.

## Gỡ cài đặt

- **Windows**: Settings → Apps → Installed apps → agentpager → Uninstall. Bộ gỡ dừng bot nếu bot chạy bằng app này, tắt tự khởi động và icon khay khi đăng nhập nếu đang trỏ tới app.
- **macOS**: Cài đặt → **Gỡ agentpager khỏi máy này…** làm các bước dọn như trên rồi mở Finder để bạn kéo agentpager vào Thùng rác.

Cấu hình, trạng thái và log của bot (`%APPDATA%\agentpager`, `~/Library/Application Support/agentpager`) **không bị xoá**: agentpager cli vẫn dùng được, cài lại app cũng dùng tiếp. Muốn xoá hẳn thì xoá thư mục đó bằng tay.

## Phát triển

Chạy từ thư mục gốc repo:

```bash
npm install
npm run build -w packages/core     # app dùng bản build của core
npm run dev -w apps/desktop        # electron-vite, renderer hot reload
npm run check -w apps/desktop      # typecheck + lint + vitest (main + renderer)
npm run pack -w apps/desktop       # build + electron-builder --dir → apps/desktop/release/
npx playwright test                # (trong apps/desktop) smoke trên bản đã pack
npm run dist -w apps/desktop       # bộ cài của máy đang chạy: .exe (Windows) hoặc .dmg (macOS)
npm run icons -w apps/desktop      # vẽ lại icon.ico, icon-mac.png và icon khay từ build/icons/*.svg
```

- Smoke test và mọi lần chạy thử nên đặt `AGENTPAGER_HOME` sang thư mục tạm để không đụng bot thật; mỗi `AGENTPAGER_HOME` có pipe IPC riêng, và app giữ profile cửa sổ (kèm khoá "chỉ một cửa sổ") trong `<AGENTPAGER_HOME>/desktop-profile` nên bản thử không đụng tới app thật đang mở. Khi đặt `AGENTPAGER_HOME`, app không bật/tắt tự khởi động, icon khay khi đăng nhập, không kiểm tra cập nhật và không hỏi chuyển vào Applications: đó là thiết lập chung của máy.
- `npx playwright test -c playwright.installer.config.ts` chạy smoke bộ cài (cài thật vào profile user rồi gỡ trên Windows; mount `.dmg` trên macOS). Bản Windows chỉ chạy trên CI (`CI=true`).
- Sửa SVG trong `build/icons` thì chạy `npm run icons` và commit file sinh ra; CI báo lỗi nếu hai bên lệch nhau.

Cấu trúc: `src/main` (tiến trình chính: daemon, service, IPC, tray, cửa sổ, `update/`, `maintenance/` cho bộ cài), `src/preload` (cầu `window.agentpager`), `src/renderer` (React), `src/shared` (kiểu dữ liệu và tên kênh dùng chung). Thiết kế: `docs/superpowers/specs/2026-09-14-agentpager-desktop-design.md`, `docs/superpowers/specs/2026-09-15-agentpager-release-design.md`.

## Phát hành

1. Tăng `version` trong `apps/desktop/package.json` và thêm mục `## <phiên bản> — <ngày>` vào `apps/desktop/CHANGELOG.md`. Nếu app cần core mới, phát hành `@chiennguyen/agentpager` trước.
2. Commit, rồi tạo và đẩy tag trùng phiên bản:

   ```bash
   git tag v0.1.0
   ```

   ```bash
   git push origin v0.1.0
   ```

3. Workflow `release` kiểm tra tag/phiên bản/changelog, build bộ cài Windows, `.dmg` arm64 và x64, chạy smoke bộ cài, rồi tải lên một **bản nháp** GitHub Release và kiểm tra đủ file.
4. Xem lại bản nháp trên GitHub rồi bấm **Publish release**. Chỉ khi đó các app đã cài mới thấy bản cập nhật.

Chạy thử không phát hành: Actions → release → **Run workflow** (bộ cài nằm trong artifacts của lần chạy).
