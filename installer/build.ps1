<#
  Build the self-contained Windows installer.

  Usage (from the repo root, on Windows):
    pwsh -File installer/build.ps1
    pwsh -File installer/build.ps1 -SkipBuild        # reuse an existing dist/
    pwsh -File installer/build.ps1 -KeepStage        # keep .installer-stage

  The installer bundles:
    * dist/ + bin/ from this repository
    * production node_modules (better-sqlite3 ships a win32-x64 prebuild)
    * node.exe (pinned version, checksum verified)
    * .cmd shims that invoke the bundled runtime
    * LarkChannelBridgeTray.exe (compiled here from installer/tray/*.cs)

  Requirements: the .NET Framework 4.x compiler (csc.exe, present on stock
  Windows 10/11 and on GitHub's windows-latest image).  NSIS is used from PATH
  or the default install directory when available; otherwise the official
  portable zip is downloaded into %LOCALAPPDATA%\LarkChannelBridge\build-tools.
#>
[CmdletBinding()]
param(
  [string]$NodeVersion = '22.18.0',
  [string]$OutDir = 'dist-installer',
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  if (-not $SkipBuild) {
    if (-not $SkipInstall) {
      Write-Host '==> pnpm install'
      corepack enable | Out-Null
      corepack pnpm install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw "pnpm install failed: $LASTEXITCODE" }
    }

    if (-not $env:LARK_BUILD_COMMIT) {
      $env:LARK_BUILD_COMMIT = (git rev-parse HEAD).Trim()
    }
    if (-not $env:LARK_BUILD_TIME) {
      $env:LARK_BUILD_TIME = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Host "==> pnpm build (commit $($env:LARK_BUILD_COMMIT))"
    corepack pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed: $LASTEXITCODE" }
  }

  if (-not (Test-Path (Join-Path $repo 'dist\cli.js'))) {
    throw 'dist/cli.js is missing; run without -SkipBuild or build first'
  }

  $package = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
  $baseVersion = [string]$package.version
  $sha = if ($env:GITHUB_SHA) { $env:GITHUB_SHA.Substring(0, 7) } else { (git rev-parse --short=7 HEAD).Trim() }
  $displayVersion = "$baseVersion+g$sha"

  $numeric = $baseVersion -replace '[^0-9.].*$', ''
  $parts = @($numeric.Split('.') | Where-Object { $_ -ne '' })
  while ($parts.Count -lt 4) { $parts += '0' }
  $productVersion = ($parts[0..3] -join '.')

  $stage = Join-Path $repo '.installer-stage'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  $app = Join-Path $stage 'app'
  $runtime = Join-Path $stage 'runtime'
  $shimDir = Join-Path $stage 'bin'
  New-Item -ItemType Directory -Force -Path $app, $runtime, $shimDir | Out-Null

  Write-Host '==> staging application'
  Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination $app -Recurse
  Copy-Item -LiteralPath (Join-Path $repo 'bin') -Destination $app -Recurse
  foreach ($file in @('LICENSE', 'README.md', 'README.zh.md')) {
    $source = Join-Path $repo $file
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $app }
  }

  # A minimal package.json: keep runtime dependencies, drop the workspace
  # package (tsup already bundled it into dist/) and all lifecycle scripts so
  # `npm install` cannot trigger another build.
  $dependencies = [ordered]@{}
  foreach ($property in $package.dependencies.PSObject.Properties) {
    if ([string]$property.Value -like 'workspace:*') { continue }
    $dependencies[$property.Name] = [string]$property.Value
  }
  $stagedPackage = [ordered]@{
    name         = [string]$package.name
    version      = [string]$package.version
    private      = $true
    type         = [string]$package.type
    dependencies = $dependencies
  }
  $stagedPackage | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding UTF8

  Write-Host '==> installing production dependencies (win32-x64 prebuilds)'
  Push-Location $app
  try {
    npm install --omit=dev --omit=optional --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $binding = @(Get-ChildItem -Path (Join-Path $app 'node_modules\better-sqlite3\build') -Filter '*.node' -Recurse -ErrorAction SilentlyContinue)
  if ($binding.Count -eq 0) {
    throw 'better-sqlite3 native binding is missing; run this build on Windows with network access'
  }

  Write-Host "==> downloading node.exe v$NodeVersion (win-x64)"
  $nodeExe = Join-Path $runtime 'node.exe'
  $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/win-x64/node.exe"
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeExe -UseBasicParsing

  $shasums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
  $expected = $null
  foreach ($line in ($shasums -split "`n")) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+win-x64/node\.exe\s*$') {
      $expected = $matches[1].ToLowerInvariant()
      break
    }
  }
  if (-not $expected) { throw "could not find node.exe checksum for v$NodeVersion" }
  $actual = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "node.exe checksum mismatch: expected $expected, got $actual" }

  Write-Host '==> writing CLI shims'
  function Write-CmdShim([string]$Name, [string]$Entry, [string]$ExtraArgs = '') {
    # Build the command in a separate statement: an unparenthesised
    # concatenation inside @() is parsed as several array elements, which splits
    # the command across lines in the generated .cmd and breaks it.
    $command = '"{0}..\runtime\node.exe" "{0}..\app\bin\{1}" {2}%*' -f '%~dp0', $Entry, $ExtraArgs
    $content = @('@echo off', 'setlocal', $command) -join "`r`n"
    [System.IO.File]::WriteAllText((Join-Path $shimDir $Name), $content + "`r`n", [System.Text.Encoding]::ASCII)
  }
  Write-CmdShim 'lark-channel-bridge.cmd' 'lark-channel-bridge.mjs'
  Write-CmdShim 'stop-gui.cmd' 'lark-channel-bridge.mjs' 'ui --stop '

  Write-Host '==> building tray launcher'
  # A tiny WinForms tray app.  .NET Framework 4.x ships csc.exe on every
  # supported Windows version, so this adds no download and no NuGet package.
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
  }
  if (-not (Test-Path -LiteralPath $csc)) {
    throw 'csc.exe (.NET Framework 4.x) not found; cannot build the tray launcher'
  }
  $traySource = Join-Path $PSScriptRoot 'tray\LarkChannelBridgeTray.cs'
  $trayIcon = Join-Path $PSScriptRoot 'tray\app.ico'
  $trayExe = Join-Path $shimDir 'LarkChannelBridgeTray.exe'
  & $csc /nologo /noconfig /target:winexe /optimize+ "/out:$trayExe" `
    "/win32icon:$trayIcon" "/resource:$trayIcon,tray.ico" `
    /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
    "$traySource"
  if ($LASTEXITCODE -ne 0) { throw "csc failed: $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $trayExe)) { throw 'tray launcher was not produced' }

  Write-Host '==> running makensis'
  $makensis = (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source
  if (-not $makensis) {
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe')
      )) {
      if ($candidate -and (Test-Path -LiteralPath $candidate)) { $makensis = $candidate; break }
    }
  }
  if (-not $makensis) {
    # The zip is the official binary distribution and needs no installer or
    # elevation, which also makes CI (windows-latest has no NSIS) reliable.
    $nsisVersion = '3.10'
    $nsisRoot = Join-Path $env:LOCALAPPDATA 'LarkChannelBridge\build-tools'
    $found = $null
    if (Test-Path -LiteralPath $nsisRoot) {
      $found = Get-ChildItem -LiteralPath $nsisRoot -Filter 'makensis.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'Stubs') } |
        Select-Object -First 1
    }
    if (-not $found) {
      Write-Host "==> downloading NSIS $nsisVersion"
      $zip = Join-Path $env:TEMP "nsis-$nsisVersion.zip"
      $url = "https://downloads.sourceforge.net/project/nsis/NSIS%203/$nsisVersion/nsis-$nsisVersion.zip"
      # SourceForge answers browser-like agents with an HTML interstitial; a
      # plain tool agent gets the archive itself.
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -UserAgent 'lark-channel-bridge-installer/1.0'
      $magic = [System.IO.File]::ReadAllBytes($zip)
      if ($magic.Length -lt 4 -or $magic[0] -ne 0x50 -or $magic[1] -ne 0x4B) {
        throw 'NSIS download did not return a zip archive; install NSIS manually and add it to PATH'
      }
      New-Item -ItemType Directory -Force -Path $nsisRoot | Out-Null
      Expand-Archive -LiteralPath $zip -DestinationPath $nsisRoot -Force
      $found = Get-ChildItem -LiteralPath $nsisRoot -Filter 'makensis.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'Stubs') } |
        Select-Object -First 1
    }
    if ($found) { $makensis = $found.FullName }
  }
  if (-not $makensis) { throw 'makensis not found; install NSIS or add it to PATH' }

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $outPath = Join-Path (Resolve-Path $OutDir).Path "LarkChannelBridge-Setup-$baseVersion-g$sha.exe"

  # NSIS resolves relative File paths against makensis' working directory, not
  # the .nsi path, so compile from the installer directory.
  Push-Location $PSScriptRoot
  try {
    & $makensis `
      "/DVERSION=$displayVersion" `
      "/DPRODUCTVERSION=$productVersion" `
      "/DSTAGE=$stage" `
      "/DOUTFILE=$outPath" `
      (Join-Path $PSScriptRoot 'bridge.nsi')
    if ($LASTEXITCODE -ne 0) { throw "makensis failed: $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $sizeMb = [math]::Round((Get-Item -LiteralPath $outPath).Length / 1MB, 1)
  Write-Host ''
  Write-Host "Installer: $outPath ($sizeMb MB)"

  if (-not $KeepStage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
} finally {
  Pop-Location
}
