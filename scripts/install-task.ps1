# Registers a scheduled task that starts claude-pager when the current user logs in.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$taskName = 'claude-pager'

if (-not (Test-Path (Join-Path $root '.env'))) {
    throw "Missing .env in $root. Copy .env.example to .env and fill it in first."
}

Push-Location $root
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
}
finally {
    Pop-Location
}

if (-not (Test-Path (Join-Path $root 'dist\index.js'))) {
    throw 'dist\index.js was not produced by the build'
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$runScript = Join-Path $root 'scripts\run.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runScript`"" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'claude-pager: Telegram remote control for Claude Code' -Force | Out-Null

Write-Host "Registered scheduled task '$taskName' (runs at logon of $user)."
Write-Host "Start it now without logging out: Start-ScheduledTask -TaskName $taskName"
