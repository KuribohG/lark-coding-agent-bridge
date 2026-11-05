<#
  Stop and remove every previous bridge installation that could keep running
  after the new files are copied.

  Runs from the NSIS installer (upgrade) and from the uninstaller:
    powershell -NoProfile -ExecutionPolicy Bypass -File stop-existing.ps1 `
      -InstallDir "<install dir>" -RecordPath "<json path>"

  The JSON record lets post-install.ps1 recreate the same services with the new
  absolute paths:
    { services: [{ taskName, profile, webUi, channelHome, state }],
      gui, guiProfile, tray }

  Deliberately conservative:
    * only touches scheduled tasks named LarkChannelBridge.Bot.*
    * only kills node.exe processes that belong to a bridge entry point
    * never deletes a source checkout; npm/pnpm global removal only unlinks the
      package from the package manager
    * keeps %USERPROFILE%\.lark-channel untouched
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$RecordPath = '',
  [switch]$SkipPackageManagers
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$logFile = Join-Path $env:TEMP 'lark-channel-bridge-installer.log'
function Write-Log([string]$Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} [stop-existing] {1}' -f (Get-Date), $Message
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch { }
}

function Get-TaskLauncher($task) {
  foreach ($action in @($task.Actions)) {
    if (-not $action) { continue }
    $path = $null
    if ($action.PSObject.Properties['Execute']) { $path = [string]$action.Execute }
    if (-not $path -and $action.PSObject.Properties['Path']) { $path = [string]$action.Path }
    if ($path -and $path -notmatch '^(cmd|cmd\.exe)$') { return $path }
  }
  return $null
}

function Read-LauncherInfo([string]$LauncherPath) {
  $info = [pscustomobject]@{ Profile = ''; WebUi = $false; ChannelHome = ''; EntryPath = '' }
  $LauncherPath = ([string]$LauncherPath).Trim().Trim('"')
  if (-not $LauncherPath -or -not (Test-Path -LiteralPath $LauncherPath)) { return $info }
  try {
    $text = Get-Content -LiteralPath $LauncherPath -Raw -Encoding UTF8
    # The launcher line is "<node.exe>" "<entry>" run [--web-ui] [--profile x].
    if ($text -match 'run\b[^\r\n]*--web-ui') { $info.WebUi = $true }
    if ($text -match 'run\b[^\r\n]*--profile\s+("[^"]+"|\S+)') {
      $info.Profile = $matches[1].Trim('"')
    }
    if ($text -match 'set\s+"?LARK_CHANNEL_HOME=([^"\r\n]*)"?') {
      $info.ChannelHome = $matches[1].Trim()
    }
    # Keep the entry path so a source checkout with an arbitrary directory name
    # can still be matched to its running node processes.
    if ($text -match '"([^"]+(?:lark-channel-bridge|run-lark-cc|cli|launcher)\.(?:mjs|js))"') {
      $info.EntryPath = $matches[1]
    }
  } catch { }
  return $info
}

function Get-BridgeProcesses([string]$RootDir, [string[]]$EntryPaths) {
  $rootLower = ($RootDir.TrimEnd('\') + '\').ToLowerInvariant()
  $entries = @()
  foreach ($entry in $EntryPaths) {
    if ($entry) { $entries += $entry.ToLowerInvariant() }
  }
  $result = @()
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
    $cmd = [string]$p.CommandLine
    $exe = [string]$p.ExecutablePath
    $cmdLower = $cmd.ToLowerInvariant()
    $exeLower = $exe.ToLowerInvariant()
    $match = $false
    if ($exeLower -and $exeLower.StartsWith($rootLower)) { $match = $true }
    if ($cmdLower) {
      if ($rootLower -and $cmdLower.Contains($rootLower)) { $match = $true }
      foreach ($entry in $entries) {
        if ($entry -and $cmdLower.Contains($entry)) { $match = $true }
      }
      # npm-global, npm-link, source-checkout and installer layouts differ; match
      # the entry scripts rather than a fixed parent directory name.
      if ($cmdLower -match '[\\/]bin[\\/]lark-channel-bridge\.mjs') { $match = $true }
      # Legacy installs (before the tray moved to the main CLI) may still have
      # a run-lark-cc supervisor running; keep matching it during upgrades.
      if ($cmdLower -match '[\\/]bin[\\/]run-lark-cc\.mjs') { $match = $true }
      if ($cmdLower -match '[\\/]bin[\\/]deadline-guard\.mjs') { $match = $true }
      if ($cmdLower -match '[\\/]bin[\\/]codex-app-server-ws-proxy\.mjs') { $match = $true }
      # The GUI supervisor / daemon runs dist/cli.js.  Require a lark path and
      # a run subcommand so an unrelated dist/cli.js is never touched.
      if ($cmdLower -match '[\\/]dist[\\/]cli\.js' -and $cmdLower -match '\srun(\s|$)' -and
          $cmdLower -match 'lark') {
        $match = $true
      }
    }
    if ($match) { $result += $p }
  }
  return $result
}

# --- 1. Scheduled tasks (per-profile services + supervisor) ------------------

$records = New-Object System.Collections.ArrayList
$entryPaths = New-Object System.Collections.ArrayList
$tasks = @()
try {
  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -like 'LarkChannelBridge.Bot.*' })
} catch { }
Write-Log ("found {0} scheduled task(s)" -f $tasks.Count)

foreach ($task in $tasks) {
  $launcher = Get-TaskLauncher $task
  $info = Read-LauncherInfo $launcher
  if ($info.EntryPath) { [void]$entryPaths.Add([string]$info.EntryPath) }
  $state = [string]$task.State
  [void]$records.Add([pscustomobject]@{
    taskName    = [string]$task.TaskName
    profile     = [string]$info.Profile
    webUi       = [bool]$info.WebUi
    channelHome = [string]$info.ChannelHome
    state       = $state
  })
  Write-Log ("task {0}: state={1} webUi={2} profile='{3}' launcher='{4}'" -f $task.TaskName, $state, $info.WebUi, $info.Profile, $launcher)
  try { Stop-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue } catch { }
  try { Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
}

# --- 2. Bridge node processes -----------------------------------------------

$processes = @(Get-BridgeProcesses $InstallDir $entryPaths.ToArray())
Write-Log ("found {0} bridge node process(es)" -f $processes.Count)

# A GUI supervisor (started by the tray, or by the legacy run-lark-cc launcher
# on an older install) is a detached `run --web-ui` process without a scheduled
# task.  Restore it only when no service was running (the two are mutually
# exclusive because they share the host lock).
$guiProcessFound = $false
$guiProfile = ''
foreach ($p in $processes) {
  $commandLine = [string]$p.CommandLine
  if ($commandLine -match '\srun\s+--web-ui') {
    $guiProcessFound = $true
    if ($commandLine -match '--profile\s+("[^"]+"|\S+)') { $guiProfile = $matches[1].Trim('"') }
  }
}
$runningServices = @($records | Where-Object { $_.state -eq 'Running' })
$supervisorServices = @($records | Where-Object { $_.webUi })
$guiWasRunning = $guiProcessFound -and $runningServices.Count -eq 0 -and $supervisorServices.Count -eq 0

foreach ($p in $processes) {
  Write-Log ("stopping pid {0}: {1}" -f $p.ProcessId, $p.CommandLine)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# --- 2b. Tray launcher ------------------------------------------------------
# It lives in <install dir>\bin and would otherwise keep the directory locked
# (blocking RMDir) and hide the new icon after the upgrade.

$trayProcesses = @()
try {
  $trayProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'LarkChannelBridgeTray.exe'" -ErrorAction SilentlyContinue)
} catch { }
$trayWasRunning = $trayProcesses.Count -gt 0
foreach ($p in $trayProcesses) {
  Write-Log ("stopping tray pid {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($RecordPath) {
  try {
    $payload = [pscustomobject]@{
      services   = [object[]]$records.ToArray()
      gui        = [bool]$guiWasRunning
      guiProfile = [string]$guiProfile
      tray       = [bool]$trayWasRunning
    }
    ConvertTo-Json -InputObject $payload -Depth 5 |
      Set-Content -LiteralPath $RecordPath -Encoding UTF8
    Write-Log ("service record written to {0}" -f $RecordPath)
  } catch {
    Write-Log ("failed to write service record: {0}" -f $_.Exception.Message)
  }
}

# Task Scheduler and node need a moment to release the old install directory.
for ($i = 0; $i -lt 40; $i++) {
  if (@(Get-BridgeProcesses $InstallDir $entryPaths.ToArray()).Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}

# --- 3. Old package-manager installs ----------------------------------------
# npm i -g installs to the npm global root; npm link creates a junction there.
# `rm -g` removes the link, never the underlying source checkout.
# pnpm is handled too because some Windows setups use it.

if (-not $SkipPackageManagers) {
  foreach ($pmName in @('npm', 'pnpm')) {
    $pm = Get-Command "$pmName.cmd" -ErrorAction SilentlyContinue
    if (-not $pm) { $pm = Get-Command $pmName -ErrorAction SilentlyContinue }
    if (-not $pm) { continue }
    $globalRoot = $null
    try { $globalRoot = (& $pm.Source root -g 2>$null | Select-Object -First 1) } catch { }
    if (-not $globalRoot) { continue }
    $globalRoot = ([string]$globalRoot).Trim()
    $packageJson = Join-Path $globalRoot 'lark-channel-bridge\package.json'
    if (Test-Path -LiteralPath $packageJson) {
      Write-Log ("removing global {0} package at {1}" -f $pmName, (Join-Path $globalRoot 'lark-channel-bridge'))
      try { & $pm.Source rm -g lark-channel-bridge --no-audit --no-fund *> $null } catch { }
    }
  }
}

Write-Log 'done'
exit 0
