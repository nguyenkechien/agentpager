# Stops and removes the claude-pager scheduled task, including the node process it started.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$taskName = 'claude-pager'

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host "Scheduled task '$taskName' is not registered."
    exit 0
}

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
}

# Stopping the task ends the supervisor; make sure the bot process it launched ends too.
$entry = Join-Path $root 'dist\index.js'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed scheduled task '$taskName'."
