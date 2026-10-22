param(
    [string]$StateDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.web-local')
)

$ErrorActionPreference = 'Stop'
$metadata = Join-Path $StateDir 'web-process.json'
if (-not (Test-Path -LiteralPath $metadata)) {
    Write-Output 'No managed Web app process recorded.'
    return
}
$record = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
$server = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $server) {
    Write-Output 'The Web app is already stopped.'
    return
}
$actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)"
$entry = Join-Path $PSScriptRoot 'run-web.mjs'
if ($record.entry -ne $entry -or -not $actual.CommandLine -or
    $server.StartTime.ToUniversalTime() -ne ([datetime]$record.started).ToUniversalTime() -or
    $actual.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw 'The recorded PID belongs to another process; refusing to stop it.'
}
& taskkill.exe /PID $record.pid /T /F
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the Web app process tree.' }
Remove-Item -LiteralPath $metadata
Write-Output 'Bridge Chat stopped. Session state is preserved.'
