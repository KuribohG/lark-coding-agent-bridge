<#
  Install -> verify -> reinstall (upgrade path) -> uninstall, on a clean runner.

  Usage:
    pwsh -File installer/smoke-test.ps1 -InstallerPath dist-installer\....exe

  Verifies:
    * silent install exits 0
    * the installed CLI loads (which imports better-sqlite3 and the workflow
      engine, so a missing win32 native binding fails here)
    * the per-user PATH entry points at the new install
    * re-running the installer over the existing install works
    * silent uninstall removes the payload, the PATH entry, but keeps
      ~/.lark-channel
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

# Turn any failure into a GitHub annotation: the step log itself needs an
# authenticated viewer, the annotation does not.
trap {
  $message = ($_.Exception.Message -replace "`r?`n", ' ').Trim()
  Write-Host ("::error::smoke test failed: {0}" -f $message)
  exit 1
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDir = Join-Path $env:LOCALAPPDATA 'LarkChannelBridge'
$configDir = Join-Path $env:USERPROFILE '.lark-channel'
$sentinel = Join-Path $configDir 'installer-smoke-test.sentinel'

function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Run-Installer {
  $p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  Assert ($p.ExitCode -eq 0) "installer exited with $($p.ExitCode)"
}

# Clean up any previous run on this runner.
$uninstaller = Join-Path $installDir 'uninstall.exe'
if (Test-Path -LiteralPath $uninstaller) {
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
  Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
Set-Content -LiteralPath $sentinel -Value 'keep-me' -Encoding ASCII

Write-Host '==> first install'
Run-Installer

$cli = Join-Path $installDir 'bin\lark-channel-bridge.cmd'
Assert (Test-Path -LiteralPath $cli) "CLI shim missing: $cli"

Write-Host '==> CLI --help'
$helpOut = Join-Path $env:TEMP 'lark-cli-help.out'
$helpErr = Join-Path $env:TEMP 'lark-cli-help.err'
Remove-Item -LiteralPath $helpOut, $helpErr -Force -ErrorAction SilentlyContinue
& $cli --help > $helpOut 2> $helpErr
$helpCode = $LASTEXITCODE
if ($helpCode -ne 0) {
  $helpText = ((Get-Content -LiteralPath $helpOut -Raw -ErrorAction SilentlyContinue) +
    (Get-Content -LiteralPath $helpErr -Raw -ErrorAction SilentlyContinue))
  throw "CLI --help exited with $helpCode; output: $helpText"
}
Assert (Test-Path -LiteralPath (Join-Path $installDir 'app\node_modules\better-sqlite3')) 'better-sqlite3 is not installed'

Write-Host '==> config check parses a TOML document'
$checkOut = Join-Path $env:TEMP 'lark-cli-config-check.out'
$checkErr = Join-Path $env:TEMP 'lark-cli-config-check.err'
Remove-Item -LiteralPath $checkOut, $checkErr -Force -ErrorAction SilentlyContinue
$configSample = Join-Path $PSScriptRoot '..\docs\config.example.toml'
Assert (Test-Path -LiteralPath $configSample) "config sample missing: $configSample"
& $cli config check --config $configSample > $checkOut 2> $checkErr
$checkCode = $LASTEXITCODE
if ($checkCode -ne 0) {
  $checkText = ((Get-Content -LiteralPath $checkOut -Raw -ErrorAction SilentlyContinue) +
    (Get-Content -LiteralPath $checkErr -Raw -ErrorAction SilentlyContinue))
  throw "config check exited with $checkCode; output: $checkText"
}

Write-Host '==> bundled lark-cli'
$larkCli = Join-Path $installDir 'app\node_modules\.bin\lark-cli.cmd'
Assert (Test-Path -LiteralPath $larkCli) "lark-cli shim missing: $larkCli"
$larkOut = Join-Path $env:TEMP 'lark-cli-version.out'
$larkErr = Join-Path $env:TEMP 'lark-cli-version.err'
Remove-Item -LiteralPath $larkOut, $larkErr -Force -ErrorAction SilentlyContinue
& $larkCli --version > $larkOut 2> $larkErr
$larkCode = $LASTEXITCODE
if ($larkCode -ne 0) {
  $larkText = ((Get-Content -LiteralPath $larkOut -Raw -ErrorAction SilentlyContinue) +
    (Get-Content -LiteralPath $larkErr -Raw -ErrorAction SilentlyContinue))
  throw "lark-cli --version exited with $larkCode; output: $larkText"
}
$larkVersion = (Get-Content -LiteralPath $larkOut -Raw).Trim()
Assert ($larkVersion -match '\d+\.\d+\.\d+') "unexpected lark-cli version output: $larkVersion"

Write-Host '==> version reports the built commit'
$version = (& $cli --version | Out-String).Trim()
Write-Host "version: $version"
Assert ($LASTEXITCODE -eq 0) "CLI --version exited with $LASTEXITCODE"
Assert ($version -match '\d+\.\d+\.\d+') "unexpected version output: $version"

Write-Host '==> background supervisor round trip'
# Exercise the exact path the tray uses for "start / open console / stop".
# A throwaway LARK_CHANNEL_HOME keeps the runner's real config untouched.
$probeHome = Join-Path $env:TEMP 'lark-channel-smoke-home'
Remove-Item -LiteralPath $probeHome -Recurse -Force -ErrorAction SilentlyContinue
$env:LARK_CHANNEL_HOME = $probeHome
try {
  $detachOut = (& $cli run --web-ui --detach 2>&1 | Out-String).Trim()
  Write-Host $detachOut
  Assert ($LASTEXITCODE -eq 0) "run --web-ui --detach exited with $LASTEXITCODE"
  $consoleUrl = (& $cli ui --print | Out-String).Trim()
  Assert ($consoleUrl -match '^http://127\.0\.0\.1:\d+/\?token=') "ui --print returned: $consoleUrl"
  & $cli ui --stop | Out-Null
  Assert ($LASTEXITCODE -eq 0) "ui --stop exited with $LASTEXITCODE"
} finally {
  Remove-Item Env:LARK_CHANNEL_HOME -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $probeHome -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host '==> tray launcher self-test'
$tray = Join-Path $installDir 'bin\LarkChannelBridgeTray.exe'
Assert (Test-Path -LiteralPath $tray) "tray launcher missing: $tray"
$trayTest = Start-Process -FilePath $tray -ArgumentList '/selftest' -Wait -PassThru
Assert ($trayTest.ExitCode -eq 0) "tray selftest exited with $($trayTest.ExitCode)"

Write-Host '==> PATH entry'
$userPath = [string](Get-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
$binDir = (Join-Path $installDir 'bin').TrimEnd('\')
Assert ($userPath.Split(';') -contains $binDir) "PATH does not contain $binDir"

Write-Host '==> reinstall over the existing installation'
Run-Installer
& $cli --help | Out-Null
Assert ($LASTEXITCODE -eq 0) "CLI --help after reinstall exited with $LASTEXITCODE"

Write-Host '==> silent uninstall'
Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -Wait | Out-Null
Start-Sleep -Seconds 2

Assert (-not (Test-Path -LiteralPath (Join-Path $installDir 'app'))) 'uninstall left app/ behind'
Assert (Test-Path -LiteralPath $sentinel) 'uninstall removed ~/.lark-channel in silent mode'

$userPath = [string](Get-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
Assert (-not ($userPath.Split(';') -contains $binDir)) "uninstall left $binDir on PATH"

Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
Write-Host 'smoke test passed'
