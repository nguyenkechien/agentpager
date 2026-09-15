export function helpLines(version: string): string[] {
  return [
    `agentpager ${version} — control a coding agent on your computer through Telegram`,
    '',
    'Usage: agentpager <command>',
    '',
    '  setup                                   Configure (bot token, users, projects folder, agent)',
    '  start [--foreground]                    Run in the background, or in this terminal',
    '  stop                                    Stop',
    '  restart                                 Restart (applies a changed config)',
    '  status                                  Status',
    '  logs [-f] [-n <lines>]                  Show the log (-f: follow)',
    '  autostart on|off|status                 Start at login',
    '  config path|show|set <key> <value>      View / edit the config',
    '  users list|add|remove|unpair <@user>    Allowed users',
    '  --version, help',
  ];
}
