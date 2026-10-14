# Botwarren ship agent installer for Windows 10/11. Per-user, never needs administrator rights.
#
#   irm https://downloads.botwarren.com/install.ps1 | iex
#
# Source: https://github.com/turbokast/botwarren-ship  (apps/shipagent/packaging/install.ps1)
#
# Options are environment variables (so they also work when piped to iex):
#   $env:BOTWARREN_BASE_URL     download base (default https://downloads.botwarren.com)
#   $env:BOTWARREN_VERSION      install this version instead of the stable one ('latest' = newest published)
#   $env:BOTWARREN_CHECKSUM_ONLY=1  no signed manifest: verify against <base>/<version>/SHA256SUMS (see below)
#   $env:BOTWARREN_INSTALL_DIR  default %LOCALAPPDATA%\Botwarren
#   $env:BOTWARREN_NO_TASK=1    do not register the background task
#   $env:BOTWARREN_NO_PATH=1    do not add the botwarren command to your user PATH
#   $env:BOTWARREN_DRY_RUN=1    print what would happen, change nothing
#   $env:BOTWARREN_CLAIM        single-use claim code from botwarren.com/get (zero-touch connect, see below)
#   $env:BOTWARREN_NO_CONNECT=1 install only; do not connect this computer to a ship
#   $env:BOTWARREN_NONINTERACTIVE=1  never start the device-code flow (scripts, provisioning)
#
# ZERO-TOUCH (what botwarren.com/get gives you: one command with a single-use claim code for your ship):
#   $env:BOTWARREN_CLAIM='bwc_xxxx'; irm https://downloads.botwarren.com/install.ps1 | iex
# The code works once and expires after 30 minutes, so it is worthless if it stays in your PowerShell history. It is read once,
# removed from the environment, and handed to `botwarren connect` only through that one process's environment: never as an
# argument, never written to a file, the scheduled task or a log, and never printed. Without a code, an interactive install ends
# by starting the device-code flow (a short code and your browser).
#
# What it does: finds the archive for this CPU in install-index.txt, downloads it, checks its SHA-256, unpacks it to a temp
# folder, runs `botwarren verify-release` (the signed manifest, Ed25519 key pinned in the agent, must contain exactly this
# archive's hash), and only then installs side by side into %LOCALAPPDATA%\Botwarren (runtime, launcher, versions), adds a
# `botwarren` command to your user PATH and registers a per-user Scheduled Task that runs the bundled node.exe directly.
#
# CHECKSUM-VERIFIED MODE, for releases that have no signed update manifest (the case until the production release key exists; see
# docs/RELEASING.md). It never falls back to this by itself: you ask for it, for example
#   $env:BOTWARREN_CHECKSUM_ONLY = '1'; $env:BOTWARREN_VERSION = '0.5.0'; irm https://downloads.botwarren.com/install.ps1 | iex
# (without BOTWARREN_VERSION it installs the newest version named in <base>/latest.txt). It downloads <base>/<version>/SHA256SUMS over
# HTTPS, checks the archive against it, checks the archive paths, then installs. This is weaker than the signed path: someone who
# controls the download host could change the archive AND its checksum, so nothing binds the file to a release key. Compare the same
# hash with the GitHub Release and its build provenance attestation (`gh attestation verify`, see the README). Auto-update is
# DISABLED for such an install until a signed manifest exists (the updater has nothing signed to fetch, so it never runs unsigned code).
#
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
  $NoPath = ($env:BOTWARREN_NO_PATH -eq '1')
  $ChecksumOnly = ($env:BOTWARREN_CHECKSUM_ONLY -eq '1')
  if ($WantVersion -eq 'latest') { $WantVersion = $null }
  # Windows-only steps (Scheduled Task, process listing, ACLs, the user PATH) are skipped elsewhere, so the rest can be tested with pwsh on Linux
  $IsWin = ($env:OS -eq 'Windows_NT')
  # the claim code is read once and removed from the environment, so nothing this script starts can see it by accident
  $Claim = $env:BOTWARREN_CLAIM
  Remove-Item Env:\BOTWARREN_CLAIM -ErrorAction SilentlyContinue
  $NoConnect = ($env:BOTWARREN_NO_CONNECT -eq '1')
  $Interactive = ($env:BOTWARREN_NONINTERACTIVE -ne '1') -and (-not $IsWin -or [Environment]::UserInteractive)

  function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
  function Fail([string]$Text) { throw "install: $Text" }
  # path pieces joined with the platform separator (works in Windows PowerShell 5.1 and PowerShell 7)
  function P([string[]]$Parts) { [IO.Path]::Combine($Parts) }
  # text of a small file, read from disk so the content type the server sends cannot change what we get (binary/octet-stream gives bytes)
  function Get-Text([string]$Url) {
    $f = Join-Path $Tmp ([Guid]::NewGuid().ToString('N') + '.txt')
    try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $f } catch { return $null }
    return [IO.File]::ReadAllText($f)
  }

  # check the claim code's shape BEFORE downloading anything, and never print it (not even in an error)
  if ($Claim -and $Claim -notmatch '^bwc_[A-Za-z0-9_-]{20,80}$') { Fail 'that command looks cut off or changed (the claim code is not valid). Copy it again from https://botwarren.com/get' }
  if ($WantVersion -and $WantVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Fail 'BOTWARREN_VERSION must look like 1.2.3 (or latest)' }
  if ($BaseUrl -notmatch '^https://' -and $BaseUrl -notmatch '^http://(127\.0\.0\.1|localhost)') { Fail "the download base must be https (got: $BaseUrl)" }
  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set - run this from a normal user session.' }
  $Root = if ($env:BOTWARREN_INSTALL_DIR) { $env:BOTWARREN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Botwarren' }
  $BinDir = Join-Path $Root 'bin'
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ('botwarren-install-' + [Guid]::NewGuid().ToString('N'))

  $arch = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  $Target = switch ($arch) { 'X64' { 'win-x64' } 'Arm64' { 'win-arm64' } default { Fail "unsupported CPU: $arch" } }

  Write-Host "Botwarren ship agent installer ($Target)"
  Write-Host "  install dir : $Root"
  Write-Host "  task        : $(if ($NoTask) { 'not registered' } else { $TaskName })"
  Write-Host "  downloads   : $BaseUrl"
  if ($ChecksumOnly) { Write-Host '  verification: SHA256SUMS over HTTPS only (no signed manifest); auto-update will be DISABLED' } else { Write-Host '  verification: signed release manifest' }
  if ($NoConnect) { Write-Host '  connect     : no (BOTWARREN_NO_CONNECT)' } elseif ($Claim) { Write-Host '  connect     : with your single-use claim code (not shown)' } else { Write-Host '  connect     : device code (an interactive install only)' }
  if ($DryRun) { Write-Host 'dry run: nothing was downloaded or changed.'; return }

  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  try {
    Write-Step 'Looking up the release'
    $Size = -1
    if ($ChecksumOnly) {
      # no signed manifest: the version is explicit (or read from latest.txt) and the hash comes from <base>/<version>/SHA256SUMS
      if ($WantVersion) { $NewVersion = $WantVersion }
      else {
        $latest = Get-Text "$BaseUrl/latest.txt"
        if (-not $latest) { Fail "could not download $BaseUrl/latest.txt" }
        $NewVersion = ($latest -split "`n")[0].Trim()
      }
      if ($NewVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Fail "bad version (expected 1.2.3, got: $NewVersion)" }
      $sums = Get-Text "$BaseUrl/$NewVersion/SHA256SUMS"
      if (-not $sums) { Fail "could not download $BaseUrl/$NewVersion/SHA256SUMS" }
      $File = "botwarren-$NewVersion-$Target.zip"
      $Sha = $null
      foreach ($l in ($sums -split "`n")) {
        $f = $l.Trim() -split '\s+'
        if ($f.Count -eq 2 -and ($f[1] -eq $File -or $f[1] -eq "*$File")) { $Sha = $f[0].ToLowerInvariant(); break }
      }
      if (-not $Sha) { Fail "SHA256SUMS for $NewVersion does not list $File" }
      $FileUrl = "$BaseUrl/$NewVersion/$File"
    } else {
      $indexText = Get-Text "$BaseUrl/install-index.txt"
      if (-not $indexText) { Fail "this release has no signed update manifest yet (could not download $BaseUrl/install-index.txt). Nothing was installed. To install a release that is verified only against its published SHA-256 checksums (auto-update stays off), set BOTWARREN_CHECKSUM_ONLY=1 (and optionally BOTWARREN_VERSION=X.Y.Z) and run again. See the README, section Install." }
      $line = $null
      foreach ($l in ($indexText -split "`n")) {
        $f = $l.Trim() -split '\s+'
        if ($f.Count -ge 5 -and $f[1] -eq $Target -and ((-not $WantVersion) -or $f[0] -eq $WantVersion)) { $line = $f; break }
      }
      if (-not $line) { Fail "no release found for $Target" }
      $NewVersion = $line[0]; $File = $line[2]; $Sha = $line[3]; $Size = [int64]$line[4]
      if ($NewVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Fail 'bad version in the index' }
      if ($File -notmatch '^[A-Za-z0-9._-]+$' -or $File.Contains('..')) { Fail 'bad file name in the index' }
      $FileUrl = "$BaseUrl/$File"
    }
    if ($Sha -notmatch '^[0-9a-f]{64}$') { Fail 'bad checksum in the index' }
    Write-Host "  version $NewVersion"

    Write-Step "Downloading $File"
    $Zip = Join-Path $Tmp $File
    Invoke-WebRequest -UseBasicParsing -Uri $FileUrl -OutFile $Zip
    if ($Size -ge 0 -and (Get-Item -LiteralPath $Zip).Length -ne $Size) { Fail 'size mismatch. Nothing was installed.' }
    if ((Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha) { Fail 'checksum mismatch: the download is not what the published hash says. Nothing was installed.' }
    Write-Host '  checksum ok'

    Write-Step 'Checking the archive'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($Zip)
    try { foreach ($e in $z.Entries) { if ($e.FullName.StartsWith('/') -or $e.FullName.Contains('..') -or $e.FullName.Contains(':') -or $e.FullName.Contains('\')) { Fail 'the archive contains unsafe paths. Nothing was installed.' } } } finally { $z.Dispose() }
    $X = Join-Path $Tmp 'x'
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $X)
    $NodeNew = P $X, 'runtime', 'node', 'node.exe'
    $CliNew = P $X, 'versions', $NewVersion, 'cli.mjs'
    if (-not (Test-Path -LiteralPath $NodeNew) -or -not (Test-Path -LiteralPath $CliNew)) { Fail 'the archive is incomplete' }

    if ($ChecksumOnly) {
      Write-Host '  NOTE: no signed release manifest was checked. This archive was verified only against the SHA256SUMS published at'
      Write-Host "        $BaseUrl/$NewVersion/ over HTTPS. Auto-update is DISABLED for this install until a signed manifest exists."
      $Verification = 'sha256sums'
    } else {
      Write-Step 'Verifying the signed release manifest'
      Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/manifest.json" -OutFile (Join-Path $Tmp 'manifest.json')
      Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/manifest.json.sig" -OutFile (Join-Path $Tmp 'manifest.json.sig')
      # the optional keys document (recovery-signed rotation/revocation, see docs/RELEASING.md): present only after a key change
      $VerifyArgs = @('--manifest', (Join-Path $Tmp 'manifest.json'), '--sig', (Join-Path $Tmp 'manifest.json.sig'), '--archive-sha256', $Sha, '--platform', $Target, '--version', $NewVersion)
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/keys.json" -OutFile (Join-Path $Tmp 'keys.json')
        Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/keys.json.sig" -OutFile (Join-Path $Tmp 'keys.json.sig')
        $VerifyArgs += @('--keys', (Join-Path $Tmp 'keys.json'), '--keys-sig', (Join-Path $Tmp 'keys.json.sig'))
      } catch { }
      & $NodeNew --disable-warning=ExperimentalWarning $CliNew verify-release @VerifyArgs
      if ($LASTEXITCODE -ne 0) { Fail 'the release signature check failed. Nothing was installed.' }
      $Verification = 'signed-manifest'
    }

    Write-Step 'Installing'
    $OldVersion = ''
    $ptrFile = Join-Path $Root 'current.json'
    $oldPtr = $null
    if (Test-Path -LiteralPath $ptrFile) { try { $oldPtr = Get-Content -LiteralPath $ptrFile -Raw | ConvertFrom-Json; if ($oldPtr.version -match '^[0-9.]+$') { $OldVersion = [string]$oldPtr.version } } catch { $oldPtr = $null } }

    # stop a running agent (the previous installer used the same task name)
    if ($IsWin) {
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
      Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Milliseconds 800
    }

    foreach ($d in @($Root, (P $Root, 'versions'), (P $Root, 'state'), (P $Root, 'launcher'), (P $Root, 'logs'), $BinDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    $nodeCur = P $Root, 'runtime', 'node', 'node.exe'
    $verCur = P $Root, 'runtime', 'NODE_VERSION'
    $sameRuntime = (Test-Path -LiteralPath $nodeCur) -and (Test-Path -LiteralPath $verCur) -and ((Get-Content -LiteralPath $verCur -Raw).Trim() -eq (Get-Content -LiteralPath (P $X, 'runtime', 'NODE_VERSION') -Raw).Trim())
    if (-not $sameRuntime) {
      $rtNew = Join-Path $Root 'runtime.new'; $rtOld = Join-Path $Root 'runtime.old'
      if (Test-Path -LiteralPath $rtNew) { Remove-Item -LiteralPath $rtNew -Recurse -Force }
      if (Test-Path -LiteralPath $rtOld) { Remove-Item -LiteralPath $rtOld -Recurse -Force }
      Move-Item -LiteralPath (P $X, 'runtime') -Destination $rtNew
      if (Test-Path -LiteralPath (Join-Path $Root 'runtime')) { Move-Item -LiteralPath (Join-Path $Root 'runtime') -Destination $rtOld }
      Move-Item -LiteralPath $rtNew -Destination (Join-Path $Root 'runtime')
      if (Test-Path -LiteralPath $rtOld) { Remove-Item -LiteralPath $rtOld -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Copy-Item -LiteralPath (P $X, 'launcher', 'launcher.mjs') -Destination (P $Root, 'launcher', 'launcher.mjs') -Force
    $verDir = P $Root, 'versions', $NewVersion
    if (-not (Test-Path -LiteralPath $verDir)) { Move-Item -LiteralPath (P $X, 'versions', $NewVersion) -Destination $verDir }
    Copy-Item -LiteralPath (Join-Path $X 'uninstall.ps1') -Destination (Join-Path $Root 'uninstall.ps1') -Force

    # pointer: a fresh install is stable; an upgrade over a different version starts in TRIAL (the launcher confirms or rolls back)
    if ($OldVersion -and $OldVersion -ne $NewVersion) {
      $kg = if ($oldPtr -and $oldPtr.knownGood) { [string]$oldPtr.knownGood } else { $OldVersion }
      $ptr = [ordered]@{ version = $NewVersion; previous = $OldVersion; knownGood = $kg; state = 'trial'; bootCount = 0; trialStarted = $null }
    } elseif ($oldPtr -and $OldVersion -eq $NewVersion) { $ptr = $oldPtr }
    else { $ptr = [ordered]@{ version = $NewVersion; previous = $null; knownGood = $NewVersion; state = 'stable'; bootCount = 0; trialStarted = $null } }
    [IO.File]::WriteAllText($ptrFile, ($ptr | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    $receipt = [ordered]@{ method = 'standalone'; installedAt = (Get-Date).ToUniversalTime().ToString('o'); version = $NewVersion; verification = $Verification }
    [IO.File]::WriteAllText((P $Root, 'state', 'install-receipt.json'), ($receipt | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    if ($IsWin) {
      # only this user may read the update state
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      & icacls.exe (P $Root, 'state') /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
    }
    Write-Host "  installed $NewVersion$(if ($OldVersion) { " (was $OldVersion)" })"

    # the `botwarren` command (absolute paths, so no new terminal is needed to run it from this installer)
    $shim = @(
      '@echo off',
      ('set "BOTWARREN_HOME={0}"' -f $Root),
      ('"{0}\runtime\node\node.exe" --disable-warning=ExperimentalWarning "{0}\launcher\launcher.mjs" cli %*' -f $Root),
      'exit /b %ERRORLEVEL%'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $BinDir 'botwarren.cmd'), $shim + "`r`n", [Text.Encoding]::ASCII)
    if ($IsWin -and -not $NoPath) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $userPath) { $userPath = '' }
      $have = $userPath.Split(';', [StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') }
      if (-not $have) { [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { $userPath.TrimEnd(';') + ';' } else { '' }) + $BinDir), 'User'); Write-Host '  added to your user PATH (open a new terminal to use "botwarren")' }
    }

    # the previous installer kept the program in <root>\app and a start-agent.ps1 launcher: remove (config and data stay)
    $legacyApp = Join-Path $Root 'app'
    if (Test-Path -LiteralPath $legacyApp) { Remove-Item -LiteralPath $legacyApp -Recurse -Force -ErrorAction SilentlyContinue; Write-Host '  migrated from the previous installer (your config and data were kept)' }

    if (-not $NoTask -and $IsWin) {
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
    if ($ChecksumOnly) { Write-Host 'Auto-update is DISABLED for this install (no signed update manifest exists yet). Verified: SHA-256 over HTTPS. To update, run this installer again.' }
    # connect this computer to the ship (after the task is registered). The claim code goes ONLY into the environment of the one
    # `connect` process, then it is dropped. It is never an argument, a file, the scheduled task or output.
    $cfg = if ($env:APPDATA) { Join-Path $env:APPDATA 'Botwarren\config.json' } else { '' }
    $botwarren = Join-Path $BinDir 'botwarren.cmd'
    if ($NoConnect) {
      Write-Host "Not connected (BOTWARREN_NO_CONNECT). When you are ready, get your command at https://botwarren.com/get or run: $botwarren connect"
    } elseif ($Claim) {
      Write-Step 'Connecting this computer to your ship'
      $env:BOTWARREN_CLAIM = $Claim
      try { & $botwarren connect; $rc = $LASTEXITCODE } catch { $rc = 1 } finally { Remove-Item Env:\BOTWARREN_CLAIM -ErrorAction SilentlyContinue; $Claim = $null }
      if ($rc -eq 0) { Write-Host 'Connected! Watch it appear at https://botwarren.com/get (or open your ship from https://botwarren.com/account).' -ForegroundColor Green }
      elseif ($rc -eq 3) { Write-Host 'This computer was already connected, so nothing changed.' }
      else {
        Write-Host 'Botwarren is installed, but this computer could not be connected.' -ForegroundColor Yellow
        Write-Host 'The claim code works once and expires after 30 minutes. If it expired, or the network was down, open https://botwarren.com/get for a fresh command.'
      }
    } elseif ($cfg -and (Test-Path -LiteralPath $cfg)) {
      Write-Host 'Your existing setup was kept. The ship agent keeps running in the background and updates itself.'
    } elseif ($Interactive) {
      Write-Step 'Connecting this computer to your ship (a short code, then your browser)'
      try { & $botwarren connect; $rc = $LASTEXITCODE } catch { $rc = 1 }
      if ($rc -ne 0 -and $rc -ne 3) { Write-Host "Could not connect right now. Botwarren is installed; open https://botwarren.com/get to connect this computer, or run: $botwarren connect" }
    } else {
      Write-Host 'Open https://botwarren.com/get to connect this computer.'
    }
    Write-Host "Status: $botwarren status     Tools it can see: $botwarren adapters     Updates: $botwarren update status"
    Write-Host 'Everything else (projects, names, delay, pause, disconnect) is on https://botwarren.com/account'
    Write-Host "Remove it:  botwarren uninstall   (or $Root\uninstall.ps1; add -KeepConfig to keep your settings)"
  }
  finally { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Install-Botwarren
