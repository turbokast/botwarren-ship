# Removes the Botwarren ship agent for the current user (Windows). No administrator needed.
#
#   & "$env:LOCALAPPDATA\Botwarren\uninstall.ps1" [-Yes] [-KeepConfig] [-KeepData]
#   botwarren uninstall [-Yes] [-KeepConfig] [-KeepData]
#
# Removes the scheduled task, the `botwarren` command from your PATH, the program files (runtime, launcher, versions,
# update state, logs) and, unless you keep them, your config + ship secret (%APPDATA%\Botwarren) and your local data
# (%LOCALAPPDATA%\Botwarren\data: private journal, tokens). Public events already published stay on your public page until
# you delete your ship on the website.
# Source: https://github.com/turbokast/botwarren-ship (apps/shipagent/packaging/uninstall.ps1)
[CmdletBinding()]
param([switch]$Yes, [switch]$KeepConfig, [switch]$KeepData, [string]$FromTemp = '')

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Continue'
$TaskName = 'Botwarren Ship Agent'
$Root = if ($env:BOTWARREN_INSTALL_DIR) { $env:BOTWARREN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Botwarren' }
$BinDir = Join-Path $Root 'bin'
$CfgDir = Join-Path $env:APPDATA 'Botwarren'
$DataDir = Join-Path $Root 'data'

# never delete a folder that is not clearly ours
if (-not $Root -or $Root.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\') -or $Root.Length -lt 12) { Write-Host "uninstall: refusing to remove '$Root'" -ForegroundColor Red; exit 1 }
if ((Test-Path -LiteralPath $Root) -and -not ((Test-Path -LiteralPath (Join-Path $Root 'current.json')) -or (Test-Path -LiteralPath (Join-Path $Root 'launcher')) -or (Test-Path -LiteralPath (Join-Path $Root 'app')))) { Write-Host "uninstall: $Root is not a Botwarren install" -ForegroundColor Red; exit 1 }

# a script cannot delete the folder it runs from: continue from a temp copy
$self = $MyInvocation.MyCommand.Path
if (-not $FromTemp -and $self -and $self.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
  $copy = Join-Path ([IO.Path]::GetTempPath()) ('botwarren-uninstall-' + [Guid]::NewGuid().ToString('N') + '.ps1')
  Copy-Item -LiteralPath $self -Destination $copy -Force
  $argList = @('-NoProfile', '-File', $copy, '-FromTemp', $copy)
  if ($Yes) { $argList += '-Yes' }; if ($KeepConfig) { $argList += '-KeepConfig' }; if ($KeepData) { $argList += '-KeepData' }
  & powershell.exe @argList
  exit $LASTEXITCODE
}

if (-not $Yes) {
  $answer = Read-Host 'This removes Botwarren (and, unless you kept them, your config, ship secret and local data). Continue? [y/N]'
  if ($answer.Trim() -notmatch '^(y|yes)$') { Write-Host 'Cancelled.'; exit 1 }
}

Write-Host '==> Stopping and removing the scheduled task'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

Write-Host '==> Removing the botwarren command from your PATH'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $kept = $userPath.Split(';', [StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_.TrimEnd('\') -ine $BinDir.TrimEnd('\') }
  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
}

Write-Host '==> Removing program files'
$keepData = $KeepData
foreach ($n in @('runtime', 'runtime.new', 'runtime.old', 'launcher', 'versions', 'staging', 'state', 'logs', 'bin', 'app', 'current.json', 'uninstall.ps1')) {
  $p = Join-Path $Root $n
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
}
if (-not $keepData -and (Test-Path -LiteralPath $DataDir)) {
  & icacls.exe $DataDir /grant "${env:USERNAME}:(OI)(CI)F" /T /C | Out-Null
  Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
} elseif ($keepData) { Write-Host "    kept local data: $DataDir" }
if (-not $KeepConfig) { if (Test-Path -LiteralPath $CfgDir) { Remove-Item -LiteralPath $CfgDir -Recurse -Force -ErrorAction SilentlyContinue } } else { Write-Host "    kept config: $CfgDir" }
if ((Test-Path -LiteralPath $Root) -and -not (Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue }
Write-Host 'Removed. Public events already published stay on your public page until you delete your ship on the website.'
if ($FromTemp -and (Test-Path -LiteralPath $FromTemp)) { Remove-Item -LiteralPath $FromTemp -Force -ErrorAction SilentlyContinue }
