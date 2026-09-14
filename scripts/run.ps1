# Supervisor for claude-pager: restarts the bot when it exits with a non-zero code.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$supervisorLog = Join-Path $logDir 'supervisor.log'
$entry = Join-Path $root 'dist\index.js'

$backoffSeconds = 5
while ($true) {
    $startedAt = Get-Date
    & node $entry
    $exitCode = $LASTEXITCODE
    $uptimeSeconds = [int]((Get-Date) - $startedAt).TotalSeconds

    if ($exitCode -eq 0) {
        Add-Content -Path $supervisorLog -Value "$(Get-Date -Format o) claude-pager exited cleanly after ${uptimeSeconds}s"
        break
    }

    # A long healthy run resets the backoff so a single crash restarts quickly.
    if ($uptimeSeconds -ge 600) { $backoffSeconds = 5 }
    Add-Content -Path $supervisorLog -Value "$(Get-Date -Format o) claude-pager exited with code $exitCode after ${uptimeSeconds}s; restarting in ${backoffSeconds}s"
    Start-Sleep -Seconds $backoffSeconds
    $backoffSeconds = [Math]::Min($backoffSeconds * 2, 300)
}
