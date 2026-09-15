# Labrastro installer for Windows — one command to get started.
#
# Install CLI (default): connects to multica.outlune.com
#   irm https://multica.outlune.com/downloads/install.ps1 | iex
#
# Self-host: starts a local Labrastro server + installs CLI + configures
#   $env:MULTICA_MODE="local"; irm https://multica.outlune.com/downloads/install.ps1 | iex
#

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
$RepoUrl       = "https://github.com/AstralSolipsism/multica.git"
$DownloadBase = if ($env:MULTICA_DOWNLOAD_BASE) { $env:MULTICA_DOWNLOAD_BASE.TrimEnd("/") } else { "https://multica.outlune.com/downloads" }
$DefaultInstallDir = Join-Path $env:USERPROFILE ".multica\server"
$InstallDir    = if ($env:MULTICA_INSTALL_DIR) { $env:MULTICA_INSTALL_DIR } else { $DefaultInstallDir }

# Host ports Compose reported after `up -d`; set by Setup-Server and reused by
# the summary so the health check and the printed URLs cannot diverge.
$script:SelfHostBackendPort  = $null
$script:SelfHostFrontendPort = $null

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Info  { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Warning $Msg }
function Write-Fail  { param([string]$Msg) throw $Msg }

function Test-CommandExists {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function New-RandomHex {
    param([int]$ByteCount)

    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return -join ($bytes | ForEach-Object { "{0:x2}" -f $_ })
}

# Host port Docker Compose actually published for a service.
#
# This is the only authority. Compose's interpolation gives the calling process
# environment precedence over .env, so an ambient PORT / BACKEND_PORT / API_PORT
# / SERVER_PORT / FRONTEND_PORT moves the published port without touching the
# file. Re-deriving the port from .env alone made the installer probe and print
# a port the stack was never published on (#6145). Must be called from the
# installation directory, after `up -d`.
function Get-ComposePublishedPort {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][int]$ContainerPort
    )

    $output = $null
    try {
        $output = docker compose -f docker-compose.selfhost.yml port $Service $ContainerPort 2>$null
    } catch {
        return $null
    }
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    $line = @($output | Where-Object { $_ }) | Select-Object -Last 1
    if (-not $line) {
        return $null
    }

    $published = ($line -split ":")[-1].Trim()
    if ($published -notmatch '^[0-9]+$') {
        return $null
    }
    return $published
}

# Legacy numeric versions are accepted only as installed migration inputs.
function Get-ReleaseParts {
    param([string]$Version)
    $match = [regex]::Match($Version, '\Av?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-labrastro\.([1-9][0-9]*))?\z')
    if (-not $match.Success) { return }
    $parts = @([bigint]$match.Groups[1].Value, [bigint]$match.Groups[2].Value, [bigint]$match.Groups[3].Value)
    if ($parts[0] -eq 0 -and $parts[1] -eq 0 -and $parts[2] -eq 0) { return }
    $revision = if ($match.Groups[4].Success) { [bigint]$match.Groups[4].Value } else { [bigint]0 }
    return $parts + @($revision)
}

function Test-NewerVersion {
    param([string]$Latest, [string]$Current)
    $next = @(Get-ReleaseParts $Latest)
    $previous = @(Get-ReleaseParts $Current)
    if ($next.Count -ne 4 -or $previous.Count -ne 4) { return $false }
    for ($i = 0; $i -lt 4; $i++) {
        if ($next[$i] -ne $previous[$i]) { return $next[$i] -gt $previous[$i] }
    }
    return $false
}

function Get-LatestVersion {
    $release = Invoke-RestMethod -Uri "$DownloadBase/latest.json" -ErrorAction Stop
    $tag = [string]$release.version
    if (@(Get-ReleaseParts $tag).Count -ne 4 -or $tag -cnotlike 'v*-labrastro.*') {
        Write-Fail "Release manifest version must be vX.Y.Z-labrastro.N."
    }
    return $tag
}

function Get-SelfHostRef {
    if ($env:MULTICA_SELFHOST_REF) {
        return $env:MULTICA_SELFHOST_REF
    }

    $latest = Get-LatestVersion
    if ($latest) {
        return $latest
    }

    return "main"
}

function Checkout-ServerRef {
    param([string]$Ref)

    # Never trust an existing checkout's origin: old installations may still
    # point upstream. All source fetches explicitly select our fork.
    git fetch --no-recurse-submodules --depth 1 -- $RepoUrl $Ref
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to fetch $Ref from the Labrastro fork." }
    git checkout --force --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to check out the fetched Labrastro source." }
}

function Pull-OfficialSelfHostImages {
    docker compose -f docker-compose.selfhost.yml pull
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host ""
    Write-Warn "Official images for the selected self-host channel are not published yet."
    Write-Host "This can happen before the first GHCR release is available."
    Write-Host "From $InstallDir, build from source instead:"
    Write-Host "  docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml up -d --build"
    exit 1
}

function Convert-ToCliArch {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }

    $normalized = "$Value".Trim().ToUpperInvariant()
    switch ($normalized) {
        "9"      { return "amd64" }
        "AMD64"  { return "amd64" }
        "X64"    { return "amd64" }
        "X86_64" { return "amd64" }
        "12"     { return "arm64" }
        "ARM64"  { return "arm64" }
        "AARCH64" { return "arm64" }
        default  { return $null }
    }
}

function Get-WindowsCliArch {
    $signals = @()
    $nativeArchSignalFound = $false

    # Prefer the native processor architecture over the current PowerShell
    # process architecture. This keeps Windows on ARM from being misdetected
    # when PowerShell is running through x64/x86 emulation.
    try {
        if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
            $processorArch = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop |
                Select-Object -First 1 -ExpandProperty Architecture
            $signals += [pscustomobject]@{ Source = "Win32_Processor.Architecture"; Value = $processorArch }
            $nativeArchSignalFound = $true
        }
    } catch {}

    try {
        if (-not $nativeArchSignalFound -and (Get-Command Get-WmiObject -ErrorAction SilentlyContinue)) {
            $processorArch = Get-WmiObject -Class Win32_Processor -ErrorAction Stop |
                Select-Object -First 1 -ExpandProperty Architecture
            $signals += [pscustomobject]@{ Source = "Win32_Processor.Architecture"; Value = $processorArch }
            $nativeArchSignalFound = $true
        }
    } catch {}

    try {
        $signals += [pscustomobject]@{
            Source = "RuntimeInformation.OSArchitecture"
            Value = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        }
    } catch {}

    $signals += [pscustomobject]@{ Source = "PROCESSOR_ARCHITEW6432"; Value = $env:PROCESSOR_ARCHITEW6432 }
    $signals += [pscustomobject]@{ Source = "PROCESSOR_ARCHITECTURE"; Value = $env:PROCESSOR_ARCHITECTURE }

    foreach ($signal in $signals) {
        $arch = Convert-ToCliArch $signal.Value
        if ($arch) {
            return $arch
        }
    }

    $details = ($signals |
        Where-Object { $null -ne $_.Value -and "$($_.Value)".Trim() -ne "" } |
        ForEach-Object { "$($_.Source)=$($_.Value)" }) -join ", "
    if (-not $details) {
        $details = "no architecture signals available"
    }

    Write-Fail "Unsupported Windows architecture ($details). Only x64 and ARM64 are supported."
}

function Get-InstalledCliVersion {
    param([string]$Path = "multica")
    $output = & $Path --version
    if ($LASTEXITCODE -ne 0) { Write-Fail "Could not read CLI version from $Path." }
    $firstLine = @($output) | Select-Object -First 1
    if ("$firstLine" -cmatch '^multica\s+(\S+)') { return $Matches[1] }
    return $null
}

function Get-AssetChecksum {
    param([string]$Manifest, [string]$Asset)
    $hash = $null
    foreach ($line in ($Manifest -split "`r?`n")) {
        $fields = $line.Trim() -split '\s+'
        if ($fields.Count -lt 2 -or ($fields[1] -creplace '^\*', '') -cne $Asset) { continue }
        if ($hash -or $fields.Count -ne 2 -or $fields[0] -notmatch '\A[0-9a-fA-F]{64}\z') {
            Write-Fail "Invalid or duplicate checksum for $Asset."
        }
        $hash = $fields[0].ToLowerInvariant()
    }
    return $hash
}

# ---------------------------------------------------------------------------
# CLI Installation
# ---------------------------------------------------------------------------
function Install-CliBinary {
    param([string]$Tag, [string]$Target)
    if (@(Get-ReleaseParts $Tag).Count -ne 4 -or $Tag -cnotlike 'v*-labrastro.*') {
        Write-Fail "Install target must be vX.Y.Z-labrastro.N."
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        Write-Fail "Labrastro requires a 64-bit Windows installation."
    }
    $arch = Get-WindowsCliArch
    $version = $Tag.Substring(1)
    $baseUrl = "$DownloadBase/cli/$Tag"
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("multica-install-" + [guid]::NewGuid().ToString("N"))
    $staged = $null
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    try {
        Write-Info "Installing Labrastro CLI $Tag from the internal release source..."
        $checksums = Invoke-WebRequest -Uri "$baseUrl/checksums.txt" -UseBasicParsing -ErrorAction Stop
        $manifest = if ($checksums.Content -is [byte[]]) {
            [System.Text.Encoding]::UTF8.GetString($checksums.Content)
        } else { [string]$checksums.Content }
        $asset = $null
        foreach ($candidate in @("multica-cli-$version-windows-$arch.zip", "multica_windows_$arch.zip")) {
            $expected = Get-AssetChecksum -Manifest $manifest -Asset $candidate
            if ($expected) { $asset = $candidate; break }
        }
        if (-not $asset) { Write-Fail "No checksummed CLI archive for windows/$arch." }
        $zipFile = Join-Path $tmpDir "multica.zip"
        Invoke-WebRequest -Uri "$baseUrl/$asset" -OutFile $zipFile -UseBasicParsing -ErrorAction Stop
        $actual = (Get-FileHash -Path $zipFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { Write-Fail "Checksum verification failed for $asset." }
        Write-Ok "Checksum verified"
        Expand-Archive -Path $zipFile -DestinationPath $tmpDir -Force
        $binaries = @(Get-ChildItem -Path $tmpDir -Filter "multica.exe" -File -Recurse)
        if ($binaries.Count -ne 1) { Write-Fail "Archive must contain exactly one multica.exe." }
        $exeSrc = $binaries[0].FullName
        $actualVersion = Get-InstalledCliVersion -Path $exeSrc
        if (-not $actualVersion -or ($actualVersion -creplace '^v', '') -cne $version) {
            Write-Fail "Downloaded CLI version ($actualVersion) does not match $Tag."
        }

        $binDir = Split-Path -Path $Target -Parent
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $staged = Join-Path $binDir ("multica-install-" + [guid]::NewGuid().ToString("N") + ".exe")
        Copy-Item -LiteralPath $exeSrc -Destination $staged
        $backup = "$target.old"
        $hadExisting = Test-Path -LiteralPath $target
        if ($hadExisting) {
            if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
            Move-Item -LiteralPath $target -Destination $backup
        }
        try {
            Move-Item -LiteralPath $staged -Destination $target
        } catch {
            if ($hadExisting) { Move-Item -LiteralPath $backup -Destination $target }
            throw
        }
        # A running Windows executable can be renamed but may still be locked
        # for deletion. The CLI also cleans this .old file on next startup.
        if ($hadExisting) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
        Add-ToUserPath $binDir
        Write-Ok "Labrastro CLI installed to $target"
    } finally {
        if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Force }
        Remove-Item -LiteralPath $tmpDir -Recurse -Force
    }
}

function Add-ToUserPath {
    param([string]$Dir)
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -and $currentPath.Split(";") -contains $Dir) {
        return
    }
    $newPath = if ($currentPath) { "$currentPath;$Dir" } else { $Dir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    # Also update current session
    if ($env:Path -notlike "*$Dir*") {
        $env:Path = "$Dir;$env:Path"
    }
    Write-Info "Added $Dir to user PATH (restart your terminal for other sessions to pick it up)."
}

function Install-Cli {
    # Check the file that will be replaced, independently of PATH lookup.
    $binDir = if ($env:MULTICA_BIN_DIR) { $env:MULTICA_BIN_DIR } else { Join-Path $env:USERPROFILE ".multica\bin" }
    $target = Join-Path $binDir "multica.exe"
    $current = $null
    if (Test-Path -LiteralPath $target) {
        $current = Get-InstalledCliVersion -Path $target
        if (@(Get-ReleaseParts $current).Count -ne 4) {
            Write-Fail "Refusing to replace a development or unrecognized build ($current)."
        }
    }
    $latest = Get-LatestVersion
    if ($current -and -not (Test-NewerVersion -Latest $latest -Current $current)) {
        Write-Ok "Labrastro CLI is up to date ($current)"
        return
    }
    Install-CliBinary -Tag $latest -Target $target
    if (-not (Test-CommandExists "multica")) {
        Write-Fail "CLI installed but 'multica' not found on PATH. Restart your terminal and try again."
    }
}

# ---------------------------------------------------------------------------
# Docker check
# ---------------------------------------------------------------------------
function Test-Docker {
    if (-not (Test-CommandExists "docker")) {
        Write-Fail @"
Docker is not installed. Labrastro self-hosting requires Docker and Docker Compose.

Install Docker Desktop for Windows:
  https://docs.docker.com/desktop/install/windows-install/

After installing Docker, re-run this script with `$env:MULTICA_MODE="local"`.
"@
    }

    try {
        docker info 2>$null | Out-Null
    } catch {
        Write-Fail "Docker is installed but not running. Please start Docker Desktop and re-run this script."
    }

    Write-Ok "Docker is available"
}

# ---------------------------------------------------------------------------
# Server setup (self-host / local)
# ---------------------------------------------------------------------------
function Install-Server {
    Write-Info "Setting up Labrastro server..."
    $serverRef = Get-SelfHostRef
    Write-Info "Using self-host assets from $serverRef..."

    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Info "Updating existing installation at $InstallDir..."
        Write-Warn "Any local changes in $InstallDir will be overwritten."
    } else {
        Write-Info "Cloning Labrastro repository..."
        if (-not (Test-CommandExists "git")) {
            Write-Fail "Git is not installed. Please install git and re-run."
        }
        if (Test-Path $InstallDir) {
            Write-Warn "Removing incomplete installation at $InstallDir..."
            Remove-Item $InstallDir -Recurse -Force
        }
        $parentDir = Split-Path $InstallDir -Parent
        if (-not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }
        git clone --depth 1 $RepoUrl $InstallDir
        if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to clone the Labrastro fork." }
    }

    Push-Location $InstallDir
    Checkout-ServerRef $serverRef
    Write-Ok "Repository ready at $InstallDir ($serverRef)"

    if (-not (Test-Path ".env")) {
        Write-Info "Creating .env with random secrets..."
        Copy-Item ".env.example" ".env"
        $jwt = New-RandomHex 32
        $pgpass = New-RandomHex 24
        $content = Get-Content ".env"
        $content = $content -replace '^JWT_SECRET=.*', "JWT_SECRET=$jwt"
        $content = $content -replace '^POSTGRES_PASSWORD=.*', "POSTGRES_PASSWORD=$pgpass"
        $content = $content -replace '^(DATABASE_URL=postgres://[^:]+:)[^@]*(@.*)', "`${1}$pgpass`${2}"
        $content | Set-Content ".env"
        Write-Ok "Generated .env with random JWT_SECRET and POSTGRES_PASSWORD"
    } else {
        Write-Ok "Using existing .env"
    }

    Write-Info "Pulling official Labrastro images..."
    Pull-OfficialSelfHostImages
    Write-Info "Starting Labrastro services (this may take a few minutes on first run)..."
    docker compose -f docker-compose.selfhost.yml up -d

    # Read the ports Compose actually published, once, and reuse them for both
    # the health check and the summary so the two can never disagree.
    $script:SelfHostBackendPort = Get-ComposePublishedPort -Service "backend" -ContainerPort 8080
    if (-not $script:SelfHostBackendPort) {
        Write-Fail "Started the stack but could not read the backend host port from Docker Compose.`n  Check it with: cd $InstallDir; docker compose -f docker-compose.selfhost.yml ps"
    }
    $script:SelfHostFrontendPort = Get-ComposePublishedPort -Service "frontend" -ContainerPort 3000
    if (-not $script:SelfHostFrontendPort) {
        Write-Fail "Started the stack but could not read the frontend host port from Docker Compose.`n  Check it with: cd $InstallDir; docker compose -f docker-compose.selfhost.yml ps"
    }

    Write-Info "Waiting for backend to be ready..."
    $ready = $false
    for ($i = 1; $i -le 45; $i++) {
        try {
            $null = Invoke-WebRequest -Uri "http://localhost:$($script:SelfHostBackendPort)/health" -UseBasicParsing -TimeoutSec 2
            $ready = $true
            break
        } catch {
            Start-Sleep -Seconds 2
        }
    }

    if ($ready) {
        Write-Ok "Labrastro server is running"
    } else {
        Write-Warn "Server is still starting. Check logs with:"
        Write-Host "  cd $InstallDir; docker compose -f docker-compose.selfhost.yml logs"
    }

    Pop-Location
}


# ---------------------------------------------------------------------------
# Main: Default mode (cloud)
# ---------------------------------------------------------------------------
function Start-DefaultInstall {
    Write-Host ""
    Write-Host "  Labrastro - Installer" -ForegroundColor White
    Write-Host ""

    Install-Cli

    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host "  [OK] Labrastro CLI is ready!" -ForegroundColor Green
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Next: configure your environment"
    Write-Host ""
    Write-Host "     multica setup               " -NoNewline; Write-Host "# Connect to Labrastro (multica.outlune.com)" -ForegroundColor DarkGray
    Write-Host "     multica setup self-host      " -NoNewline; Write-Host "# Connect to a self-hosted server" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Self-hosting? Install the server first:"
    Write-Host '     $env:MULTICA_MODE="with-server"; irm https://multica.outlune.com/downloads/install.ps1 | iex'
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Main: Local mode (self-host)
# ---------------------------------------------------------------------------
function Start-LocalInstall {
    Write-Host ""
    Write-Host "  Labrastro - Self-Host Installer" -ForegroundColor White
    Write-Host "  Provisioning server infrastructure + installing CLI"
    Write-Host ""

    Test-Docker
    Install-Server
    Install-Cli

    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host "  [OK] Labrastro server is running and CLI is ready!" -ForegroundColor Green
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Frontend:  http://localhost:$($script:SelfHostFrontendPort)"
    Write-Host "  Backend:   http://localhost:$($script:SelfHostBackendPort)"
    Write-Host "  Server at: $InstallDir"
    Write-Host ""
    Write-Host "  Next: configure your CLI to connect"
    Write-Host ""
    Write-Host "     multica setup self-host  " -NoNewline; Write-Host "# Configure + authenticate + start daemon" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Login: configure RESEND_API_KEY in .env for email codes,"
    Write-Host "  or read the generated code from backend logs when Resend is unset."
    Write-Host ""
    Write-Host "  To stop all services:"
    Write-Host '     $env:MULTICA_MODE="stop"; irm https://multica.outlune.com/downloads/install.ps1 | iex'
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Stop: shut down a self-hosted installation
# ---------------------------------------------------------------------------
function Start-Stop {
    Write-Host ""
    Write-Info "Stopping Labrastro services..."

    if (Test-Path $InstallDir) {
        Push-Location $InstallDir
        if (Test-Path "docker-compose.selfhost.yml") {
            docker compose -f docker-compose.selfhost.yml down
            Write-Ok "Docker services stopped"
        } else {
            Write-Warn "No docker-compose.selfhost.yml found at $InstallDir"
        }
        Pop-Location
    } else {
        Write-Warn "No Labrastro installation found at $InstallDir"
    }

    if (Test-CommandExists "multica") {
        try {
            multica daemon stop 2>$null
            Write-Ok "Daemon stopped"
        } catch {}
    }

    Write-Host ""
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
$mode = if ($env:MULTICA_MODE) { $env:MULTICA_MODE.ToLower() } else { "default" }

switch ($mode) {
    "with-server" { Start-LocalInstall }
    "local"       { Start-LocalInstall }  # backwards compat alias
    "stop"        { Start-Stop }
    default       { Start-DefaultInstall }
}
