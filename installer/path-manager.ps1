<#
  Add/remove the per-user PATH entry for the installed CLI shims.

  Only the user's PATH is touched (HKCU\Environment\Path), never the machine
  PATH, so the installer stays admin-free.  The entry is prepended on install so
  a stale npm-global `lark-channel-bridge.cmd` cannot win the lookup order.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action
)

$ErrorActionPreference = 'SilentlyContinue'

function Normalize-Path([string]$Value) {
  return $Value.Trim().TrimEnd('\').ToLowerInvariant()
}

$bin = Join-Path $InstallDir 'bin'
$binNorm = Normalize-Path $bin

# Read the registry value directly so an existing REG_EXPAND_SZ PATH keeps its
# type and its unexpanded %USERPROFILE%-style entries.
$envKey = Get-Item -LiteralPath 'HKCU:\Environment' -ErrorAction SilentlyContinue
$current = ''
$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
if ($envKey) {
  $current = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  try { $kind = $envKey.GetValueKind('Path') } catch { }
}
if ($null -eq $current) { $current = '' }

$parts = @()
foreach ($part in ($current -split ';')) {
  if (-not $part -or -not $part.Trim()) { continue }
  if ((Normalize-Path $part) -eq $binNorm) { continue }
  $parts += $part.Trim()
}

if ($Action -eq 'add') {
  $parts = @($bin) + $parts
}

$updated = ($parts -join ';')
if ($updated -eq $current) { exit 0 }

New-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $updated -PropertyType $kind -Force | Out-Null

# Tell Explorer and already-running shells that the environment changed.
try {
  $signature = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
  IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
  uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  $type = Add-Type -MemberDefinition $signature -Name 'Win32SendMessageTimeout' -Namespace 'LarkChannelBridgeInstaller' -PassThru
  $result = [UIntPtr]::Zero
  [void]$type::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
} catch { }

exit 0
