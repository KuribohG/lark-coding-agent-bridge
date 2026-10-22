param(
    [string]$Workspace = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$StateDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.web-local'),
    [ValidateRange(1, 65535)][int]$Port = 8787,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$StateDir = [IO.Path]::GetFullPath($StateDir)
$entry = Join-Path $PSScriptRoot 'run-web.mjs'
$stdout = Join-Path $StateDir 'web.stdout.log'
$stderr = Join-Path $StateDir 'web.stderr.log'
$metadata = Join-Path $StateDir 'web-process.json'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
$codex = if ($codexCommand) { $codexCommand.Source } else { $env:CODEX_CLI_PATH }
if (-not $codex -or -not (Test-Path -LiteralPath $codex)) {
    $codex = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $codex) { throw 'Codex CLI not found. Install it or add codex.exe to PATH.' }
if (-not (Test-Path -LiteralPath (Join-Path $repository 'dist\cli.js'))) {
    throw 'Build missing. Run npx --yes pnpm@10.33.0 install --frozen-lockfile in the repository first.'
}
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. The running app URL is in $stdout."
}
$stateLock = Join-Path $StateDir 'web-state\web-host.lock.lock'
if (Test-Path -LiteralPath $stateLock) {
    $lockAge = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $stateLock).LastWriteTimeUtc).TotalSeconds
    $waitSeconds = [Math]::Max(0, [Math]::Ceiling(31 - $lockAge))
    if ($waitSeconds -gt 0) {
        Write-Output "Waiting $waitSeconds seconds for the previous state lock to expire..."
        Start-Sleep -Seconds $waitSeconds
    }
}
$previousStateDir = $env:BRIDGE_WEB_STATE_DIR
$previousBridgeHome = $env:LARK_CHANNEL_HOME
$env:BRIDGE_WEB_STATE_DIR = $StateDir
$env:LARK_CHANNEL_HOME = Join-Path $StateDir 'bridge-home'
$arguments = @(
    '"' + $entry + '"', 'web', '--agent', 'codex',
    '--workspace', '"' + $Workspace + '"',
    '--state-dir', '"' + (Join-Path $StateDir 'web-state') + '"',
    '--binary', '"' + $codex + '"', '--port', "$Port"
)
try {
    $server = Start-Process -FilePath $node -ArgumentList ($arguments -join ' ') -WorkingDirectory $repository -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
} finally {
    $env:BRIDGE_WEB_STATE_DIR = $previousStateDir
    $env:LARK_CHANNEL_HOME = $previousBridgeHome
}
@{ pid = $server.Id; started = $server.StartTime.ToUniversalTime().ToString('o'); entry = $entry; port = $Port } |
    ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding UTF8
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 250
    $server.Refresh()
    if ($server.HasExited) {
        throw ("Web app exited: " + (Get-Content -LiteralPath $stderr -Raw))
    }
    $output = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue
    if ($output -match 'Bridge Chat: (http://127\.0\.0\.1:\d+/#token=[a-f0-9]+)') {
        $url = $Matches[1]
        Write-Output "Bridge Chat PID: $($server.Id)"
        Write-Output $url
        if ($OpenBrowser) { Start-Process $url }
        return
    }
} while ((Get-Date) -lt $deadline)
throw "Startup timed out. Inspect $stdout and $stderr."
