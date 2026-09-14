export function helpLines(version: string): string[] {
  return [
    `agentpager ${version} — điều khiển agent lập trình trên máy qua Telegram`,
    '',
    'Cách dùng: agentpager <lệnh>',
    '',
    '  setup [--import <thư mục>]              Cấu hình (nhập từ claude-pager cũ với --import)',
    '  start [--foreground]                    Chạy nền, hoặc chạy trong terminal này',
    '  stop                                    Dừng',
    '  restart                                 Khởi động lại (áp dụng cấu hình mới)',
    '  status                                  Trạng thái',
    '  logs [-f] [-n <số dòng>]                Xem log (-f: theo dõi)',
    '  autostart on|off|status                 Tự khởi động khi đăng nhập',
    '  config path|show|set <khoá> <giá trị>   Xem / sửa cấu hình',
    '  users list|add|remove|unpair <@user>    Người dùng được phép',
    '  --version, help',
  ];
}
