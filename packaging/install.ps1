# Botwarren ship agent installer for Windows 10/11. Per-user, never needs administrator rights.
#
#   irm https://downloads.botwarren.com/install.ps1 | iex
#
# Source: https://github.com/turbokast/botwarren-ship  (apps/shipagent/packaging/install.ps1)
#
# Options are environment variables (so they also work when piped to iex):
#   $env:BOTWARREN_BASE_URL     download base (default https://downloads.botwarren.com)
#   $env:BOTWARREN_VERSION      install this version instead of the stable one
#   $env:BOTWARREN_INSTALL_DIR  default %LOCALAPPDATA%\Botwarren
#   $env:BOTWARREN_NO_TASK=1    do not register the background task
#   $env:BOTWARREN_DRY_RUN=1    print what would happen, change nothing
#
# What it does: finds the archive for this CPU in install-index.txt, downloads it, checks its SHA-256, unpacks it to a temp
# folder, runs `botwarren verify-release` (the signed manifest, Ed25519 key pinned in the agent, must contain exactly this
# archive's hash), and only then installs side by side into %LOCALAPPDATA%\Botwarren (runtime, launcher, versions), adds a
# `botwarren` command to your user PATH and registers a per-user Scheduled Task that runs the bundled node.exe directly.
# There is no PowerShell execution-policy bypass anywhere: nothing here or at runtime uses -ExecutionPolicy Bypass.
#
# UNVERIFIED on real Windows hardware at the time of writing (see docs/ARCHITECTURE.md, spike S1): the logon
# task, the brief console flash, SmartScreen and Smart App Control behaviour need a test on clean Windows 10 and 11 machines.

function Install-Botwarren {
  Set-StrictMode -Version 2.0
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $TaskName = 'Botwarren Ship Agent'
  $BaseUrl = if ($env:BOTWARREN_BASE_URL) { $env:BOTWARREN_BASE_URL.TrimEnd('/') } else { 'https://downloads.botwarren.com' }
  $WantVersion = $env:BOTWARREN_VERSION
  $DryRun = ($env:BOTWARREN_DRY_RUN -eq '1')
  $NoTask = ($env:BOTWARREN_NO_TASK -eq '1')

  function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
  function Fail([string]$Text) { throw "install: $Text" }

  if ($BaseUrl -notmatch '^https://' -and $BaseUrl -notmatch '^http://(127\.0\.0\.1|localhost)') { Fail "the download base must be https (got: $BaseUrl)" }
  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set - run this from a normal user session.' }
  $Root = if ($env:BOTWARREN_INSTALL_DIR) { $env:BOTWARREN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Botwarren' }
  $BinDir = Join-Path $Root 'bin'

  $arch = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  $Target = switch ($arch) { 'X64' { 'win-x64' } 'Arm64' { 'win-arm64' } default { Fail "unsupported CPU: $arch" } }

  Write-Host "Botwarren ship agent installer ($Target)"
  Write-Host "  install dir : $Root"
  Write-Host "  task        : $(if ($NoTask) { 'not registered' } else { $TaskName })"
  Write-Host "  downloads   : $BaseUrl"
  if ($DryRun) { Write-Host 'dry run: nothing was downloaded or changed.'; return }

  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ('botwarren-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  try {
    Write-Step 'Looking up the release'
    $indexText = (Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/install-index.txt").Content
    $line = $null
    foreach ($l in ($indexText -split "`n")) {
      $f = $l.Trim() -split '\s+'
      if ($f.Count -ge 5 -and $f[1] -eq $Target -and ((-not $WantVersion) -or $f[0] -eq $WantVersion)) { $line = $f; break }
    }
    if (-not $line) { Fail "no release found for $Target" }
    $NewVersion = $line[0]; $File = $line[2]; $Sha = $line[3]; $Size = [int64]$line[4]
    if ($NewVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Fail 'bad version in the index' }
    if ($File -notmatch '^[A-Za-z0-9._-]+$' -or $File.Contains('..')) { Fail 'bad file name in the index' }
    if ($Sha -notmatch '^[0-9a-f]{64}$') { Fail 'bad checksum in the index' }
    Write-Host "  version $NewVersion"

    Write-Step "Downloading $File"
    $Zip = Join-Path $Tmp $File
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$File" -OutFile $Zip
    if ((Get-Item -LiteralPath $Zip).Length -ne $Size) { Fail 'size mismatch. Nothing was installed.' }
    if ((Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha) { Fail 'checksum mismatch: the download is not what the index says. Nothing was installed.' }
    Write-Host '  checksum ok'

    Write-Step 'Checking the archive'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($Zip)
    try { foreach ($e in $z.Entries) { if ($e.FullName.StartsWith('/') -or $e.FullName.Contains('..') -or $e.FullName.Contains(':') -or $e.FullName.Contains('\')) { Fail 'the archive contains unsafe paths. Nothing was installed.' } } } finally { $z.Dispose() }
    $X = Join-Path $Tmp 'x'
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $X)
    $NodeNew = Join-Path $X 'runtime\node\node.exe'
    $CliNew = Join-Path $X "versions\$NewVersion\cli.mjs"
    if (-not (Test-Path -LiteralPath $NodeNew) -or -not (Test-Path -LiteralPath $CliNew)) { Fail 'the archive is incomplete' }

    Write-Step 'Verifying the signed release manifest'
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/manifest.json" -OutFile (Join-Path $Tmp 'manifest.json')
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/manifest.json.sig" -OutFile (Join-Path $Tmp 'manifest.json.sig')
    & $NodeNew --disable-warning=ExperimentalWarning $CliNew verify-release --manifest (Join-Path $Tmp 'manifest.json') --sig (Join-Path $Tmp 'manifest.json.sig') --archive-sha256 $Sha --platform $Target --version $NewVersion
    if ($LASTEXITCODE -ne 0) { Fail 'the release signature check failed. Nothing was installed.' }

    Write-Step 'Installing'
    $OldVersion = ''
    $ptrFile = Join-Path $Root 'current.json'
    $oldPtr = $null
    if (Test-Path -LiteralPath $ptrFile) { try { $oldPtr = Get-Content -LiteralPath $ptrFile -Raw | ConvertFrom-Json; if ($oldPtr.version -match '^[0-9.]+$') { $OldVersion = [string]$oldPtr.version } } catch { $oldPtr = $null } }

    # stop a running agent (the previous installer used the same task name)
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800

    foreach ($d in @($Root, "$Root\versions", "$Root\state", "$Root\launcher", "$Root\logs", $BinDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    $nodeCur = Join-Path $Root 'runtime\node\node.exe'
    $verCur = Join-Path $Root 'runtime\NODE_VERSION'
    $sameRuntime = (Test-Path -LiteralPath $nodeCur) -and (Test-Path -LiteralPath $verCur) -and ((Get-Content -LiteralPath $verCur -Raw).Trim() -eq (Get-Content -LiteralPath (Join-Path $X 'runtime\NODE_VERSION') -Raw).Trim())
    if (-not $sameRuntime) {
      $rtNew = Join-Path $Root 'runtime.new'; $rtOld = Join-Path $Root 'runtime.old'
      if (Test-Path -LiteralPath $rtNew) { Remove-Item -LiteralPath $rtNew -Recurse -Force }
      if (Test-Path -LiteralPath $rtOld) { Remove-Item -LiteralPath $rtOld -Recurse -Force }
      Move-Item -LiteralPath (Join-Path $X 'runtime') -Destination $rtNew
      if (Test-Path -LiteralPath (Join-Path $Root 'runtime')) { Move-Item -LiteralPath (Join-Path $Root 'runtime') -Destination $rtOld }
      Move-Item -LiteralPath $rtNew -Destination (Join-Path $Root 'runtime')
      if (Test-Path -LiteralPath $rtOld) { Remove-Item -LiteralPath $rtOld -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Copy-Item -LiteralPath (Join-Path $X 'launcher\launcher.mjs') -Destination (Join-Path $Root 'launcher\launcher.mjs') -Force
    $verDir = Join-Path $Root "versions\$NewVersion"
    if (-not (Test-Path -LiteralPath $verDir)) { Move-Item -LiteralPath (Join-Path $X "versions\$NewVersion") -Destination $verDir }
    Copy-Item -LiteralPath (Join-Path $X 'uninstall.ps1') -Destination (Join-Path $Root 'uninstall.ps1') -Force

    # pointer: a fresh install is stable; an upgrade over a different version starts in TRIAL (the launcher confirms or rolls back)
    if ($OldVersion -and $OldVersion -ne $NewVersion) {
      $kg = if ($oldPtr -and $oldPtr.knownGood) { [string]$oldPtr.knownGood } else { $OldVersion }
      $ptr = [ordered]@{ version = $NewVersion; previous = $OldVersion; knownGood = $kg; state = 'trial'; bootCount = 0; trialStarted = $null }
    } elseif ($oldPtr -and $OldVersion -eq $NewVersion) { $ptr = $oldPtr }
    else { $ptr = [ordered]@{ version = $NewVersion; previous = $null; knownGood = $NewVersion; state = 'stable'; bootCount = 0; trialStarted = $null } }
    [IO.File]::WriteAllText($ptrFile, ($ptr | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    $receipt = [ordered]@{ method = 'standalone'; installedAt = (Get-Date).ToUniversalTime().ToString('o'); version = $NewVersion }
    [IO.File]::WriteAllText((Join-Path $Root 'state\install-receipt.json'), ($receipt | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    # only this user may read the update state
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe (Join-Path $Root 'state') /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
    Write-Host "  installed $NewVersion$(if ($OldVersion) { " (was $OldVersion)" })"

    # the `botwarren` command (absolute paths, so no new terminal is needed to run it from this installer)
    $shim = @(
      '@echo off',
      ('set "BOTWARREN_HOME={0}"' -f $Root),
      ('"{0}\runtime\node\node.exe" --disable-warning=ExperimentalWarning "{0}\launcher\launcher.mjs" cli %*' -f $Root),
      'exit /b %ERRORLEVEL%'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $BinDir 'botwarren.cmd'), $shim + "`r`n", [Text.Encoding]::ASCII)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $userPath) { $userPath = '' }
    $have = $userPath.Split(';', [StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') }
    if (-not $have) { [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { $userPath.TrimEnd(';') + ';' } else { '' }) + $BinDir), 'User'); Write-Host '  added to your user PATH (open a new terminal to use "botwarren")' }

    # the previous installer kept the program in <root>\app and a start-agent.ps1 launcher: remove (config and data stay)
    $legacyApp = Join-Path $Root 'app'
    if (Test-Path -LiteralPath $legacyApp) { Remove-Item -LiteralPath $legacyApp -Recurse -Force -ErrorAction SilentlyContinue; Write-Host '  migrated from the previous installer (your config and data were kept)' }

    if (-not $NoTask) {
      Write-Step "Registering the scheduled task '$TaskName'"
      $user = "$($env:USERDOMAIN)\$($env:USERNAME)"
      # runs the bundled node.exe DIRECTLY (no PowerShell host, no execution-policy bypass). The launcher hides its own window.
      $action = New-ScheduledTaskAction -Execute (Join-Path $Root 'runtime\node\node.exe') -Argument ('--disable-warning=ExperimentalWarning "{0}" run' -f (Join-Path $Root 'launcher\launcher.mjs')) -WorkingDirectory $Root
      $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
      # a repeating trigger restarts a dead launcher (the launcher keeps itself single-instance with a lock file)
      $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $repeat) -Settings $settings -Principal $principal -Description 'Botwarren ship agent: publishes enum-only, delayed status of your AI coding agents. Local only otherwise.' -Force | Out-Null
      Start-ScheduledTask -TaskName $TaskName
    }

    Write-Host ''
    Write-Host "Botwarren $NewVersion is installed." -ForegroundColor Green
    $cfg = Join-Path $env:APPDATA 'Botwarren\config.json'
    if (Test-Path -LiteralPath $cfg) { Write-Host 'Your existing configuration was kept. The ship agent is running in the background.' }
    else { Write-Host "Next: connect this computer to your ship:   $BinDir\botwarren.cmd pair"; Write-Host '(the agent starts by itself as soon as the connection is set up)' }
    Write-Host "Check updates and options: $BinDir\botwarren.cmd update status    Tools it can see: $BinDir\botwarren.cmd adapters"
    Write-Host "Remove everything:        $Root\uninstall.ps1   (add -KeepConfig to keep your settings)"
  }
  finally { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Install-Botwarren
