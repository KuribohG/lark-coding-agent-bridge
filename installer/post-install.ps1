<#
  Recreate the services that stop-existing.ps1 recorded, using the new
  absolute node/CLI paths.

  Why this is necessary: the Windows service is a Task Scheduler task that runs
  ~/.lark-channel/daemon/<id>/launcher.cmd, and that .cmd file has the node.exe
  path and the CLI entry path baked in. Upgrading from an npm-global install (or
  any other directory) would otherwise leave the task pointing at deleted files.

  The previous run state is preserved:
    Running  -> service is started
    Disabled -> service is created, then ended and disabled (the same state
                `lark-channel-bridge stop` produces)
    Ready    -> service is created, then ended but left enabled
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$RecordPath
)

$ErrorActionPreference = 'SilentlyContinue'

$logFile = Join-Path $env:TEMP 'lark-channel-bridge-installer.log'
function Write-Log([string]$Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} [post-install] {1}' -f (Get-Date), $Message
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch { }
}

$node = Join-Path $InstallDir 'runtime\node.exe'
$cli = Join-Path $InstallDir 'app\bin\lark-channel-bridge.mjs'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $cli)) {
  Write-Log 'installed node/CLI missing; nothing to restart'
  exit 0
}

$records = @()
$guiWasRunning = $false
$guiProfile = ''
$trayWasRunning = $false
if ($RecordPath -and (Test-Path -LiteralPath $RecordPath)) {
  try {
    $raw = Get-Content -LiteralPath $RecordPath -Raw -Encoding UTF8
    if ($raw -and $raw.Trim()) {
      $parsed = $raw | ConvertFrom-Json
      if ($parsed -is [System.Array]) {
        # Older record format: a bare service array.
        $records = @($parsed)
      } elseif ($null -ne $parsed) {
        if ($parsed.services) { $records = @($parsed.services) }
        elseif ($parsed.taskName) { $records = @($parsed) }
        $guiWasRunning = [bool]$parsed.gui
        $guiProfile = [string]$parsed.guiProfile
        $trayWasRunning = [bool]$parsed.tray
      }
    }
  } catch {
    Write-Log ("cannot parse service record: {0}" -f $_.Exception.Message)
  }
}
Write-Log ("restoring {0} service(s), gui={1} guiProfile='{2}' tray={3}" -f $records.Count, $guiWasRunning, $guiProfile, $trayWasRunning)

# The daemon bakes process.env.PATH into launcher.cmd, so make sure it can
# resolve the bundled node, npm's global shims (lark-cli, claude, codex) and
# the user's normal tools.
$env:PATH = @(
  (Join-Path $InstallDir 'bin'),
  (Join-Path $InstallDir 'runtime'),
  (Join-Path $env:APPDATA 'npm'),
  $env:PATH
) -join ';'

foreach ($record in $records) {
  if (-not $record) { continue }
  $taskName = [string]$record.taskName
  if (-not $taskName) { continue }

  # Start-Process joins an array with spaces without quoting, so quote the
  # entry path explicitly (usernames and custom install dirs may contain spaces).
  $argLine = '"' + $cli + '" start'
  $profile = [string]$record.profile
  $webUi = [bool]$record.webUi
  # Older record format stored one combined profileArg string.
  $legacy = [string]$record.profileArg
  if (-not $profile -and $legacy -match '^--profile\s+(.+)$') { $profile = $matches[1] }
  if ($legacy -eq '--web-ui') { $webUi = $true }
  if ($webUi) { $argLine += ' --web-ui' }
  if ($profile) { $argLine += ' --profile "' + $profile + '"' }

  # Never let one service's home leak into the next one (or into the tray).
  if ($record.channelHome) {
    $env:LARK_CHANNEL_HOME = [string]$record.channelHome
  } else {
    Remove-Item Env:LARK_CHANNEL_HOME -ErrorAction SilentlyContinue
  }

  Write-Log ("start {0}" -f $argLine)
  # Non-interactive stdio makes the CLI skip its lark-cli auto-install prompt.
  # Bound the wait: `start` may wait for the bot to connect, but it must never
  # block the installer forever on a stale lock or a dead network.
  $process = Start-Process -FilePath $node -ArgumentList $argLine -PassThru -NoNewWindow
  if ($process) {
    $exited = $process.WaitForExit(180000)
    if ($exited) {
      Write-Log ("exit code {0}" -f $process.ExitCode)
    } else {
      Write-Log 'start did not finish within 180s; leaving the service registered'
      try { $process.Kill() } catch { }
    }
  }

  switch ([string]$record.state) {
    'Running' {
      & schtasks.exe /Run /TN $taskName *> $null
    }
    'Disabled' {
      & schtasks.exe /End /TN $taskName *> $null
      & schtasks.exe /Change /TN $taskName /Disable *> $null
    }
    default {
      & schtasks.exe /End /TN $taskName *> $null
    }
  }
}

# The tray/GUI use the default config root; do not inherit a service's custom
# LARK_CHANNEL_HOME from the loop above.
Remove-Item Env:LARK_CHANNEL_HOME -ErrorAction SilentlyContinue

# Restore the tray launcher first when it was the owner of the GUI supervisor:
# it starts the supervisor quietly and brings back the icon the user expects.
$trayExe = Join-Path $InstallDir 'bin\LarkChannelBridgeTray.exe'
if ($trayWasRunning -and (Test-Path -LiteralPath $trayExe)) {
  Write-Log 'restarting tray launcher'
  Start-Process -FilePath $trayExe -ArgumentList '/quiet' -ErrorAction SilentlyContinue
}

# Restore a GUI supervisor that was started through run-lark-cc.  --print keeps
# the browser closed during an upgrade.  It is detached, so the installer does
# not block on it.  When the tray is restored it starts the supervisor itself.
if ($guiWasRunning -and -not $trayWasRunning) {
  $launcherEntry = Join-Path $InstallDir 'app\bin\run-lark-cc.mjs'
  if (Test-Path -LiteralPath $launcherEntry) {
    $guiArgs = '"' + $launcherEntry + '" start --print'
    if ($guiProfile) { $guiArgs += ' --profile "' + $guiProfile + '"' }
    Write-Log ("restarting run-lark-cc GUI supervisor: {0}" -f $guiArgs)
    Start-Process -FilePath $node -ArgumentList $guiArgs `
      -WindowStyle Hidden -ErrorAction SilentlyContinue
  }
}

Write-Log 'done'
exit 0
