# Install the game and everything Python bots need on Windows, then join a server.
#
#   $env:RS_REPO='<git url>'; $env:RS_BRANCH='<branch>'; $env:RS_INVITE='<invite-code>'
#   irm <raw url of this file> | iex
#
# Installs Git, Python and Bun with winget if they are missing, downloads the
# game into %USERPROFILE%\rs-sdk (RS_DIR to change), installs its packages and
# the Python rs package, and saves the invite's bot.env. Safe to run again.

$ErrorActionPreference = 'Stop'

$Repo = if ($env:RS_REPO) { $env:RS_REPO } else { 'https://github.com/MaxBittker/rs-sdk.git' }
$Branch = if ($env:RS_BRANCH) { $env:RS_BRANCH } else { 'main' }
$Dir = if ($env:RS_DIR) { $env:RS_DIR } else { Join-Path $env:USERPROFILE 'rs-sdk' }
$Invite = $env:RS_INVITE

function Say($text) { Write-Host "[install] $text" -ForegroundColor Cyan }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Python-Ok {
    if (-not (Have 'python')) { return $false }
    & python -c "import sys, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
    return $LASTEXITCODE -eq 0
}

if (-not (Have 'winget')) {
    throw 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.'
}

if (-not (Have 'git')) {
    Say 'Installing Git...'
    winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    Refresh-Path
}
if (-not (Python-Ok)) {
    Say 'Installing Python...'
    winget install --id Python.Python.3.12 -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    Refresh-Path
    if (-not (Python-Ok)) { throw 'Python did not install. Install Python 3.9+ from https://python.org (tick "Add to PATH"), then run this again.' }
}
if (-not (Have 'bun')) {
    Say 'Installing Bun...'
    winget install --id Oven-sh.Bun -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    Refresh-Path
    $bunBin = Join-Path $env:USERPROFILE '.bun\bin'
    if (Test-Path $bunBin) { $env:Path = "$bunBin;$env:Path" }
    if (-not (Have 'bun')) { throw 'Bun did not install. See https://bun.sh' }
}

if (Test-Path (Join-Path $Dir '.git')) {
    Say "Updating the game in $Dir..."
    git -C $Dir pull --ff-only --quiet
} else {
    Say "Downloading the game into $Dir..."
    git clone --quiet --depth 1 --branch $Branch $Repo $Dir
}
Set-Location $Dir

Say 'Installing packages...'
$env:PUPPETEER_SKIP_DOWNLOAD = '1'
bun install --silent --production

Say 'Setting up Python...'
if (-not (Test-Path '.venv\Scripts\python.exe')) { python -m venv .venv }
& .venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -e python/

$bot = '<your bot name>'
if ($Invite) {
    $out = bun join.ts $Invite
    if ($LASTEXITCODE -ne 0) { throw ($out -join "`n") }
    $out | Select-Object -First 2 | ForEach-Object { Write-Host $_ }
    $line = $out | Where-Object { $_ -like 'Start playing:*' }
    if ($line) { $bot = ($line -replace '^Start playing:\s+bun play.ts\s+', '') }
}

Write-Host ''
Write-Host 'Installed! To play, open a new terminal and run:'
Write-Host ''
Write-Host "  cd $Dir"
Write-Host "  bun play.ts $bot"
Write-Host ''
