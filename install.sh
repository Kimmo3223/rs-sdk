#!/usr/bin/env bash
# Install the game and everything Python bots need, then join a server.
#
#   curl -fsSL <raw url of this file> | RS_REPO=<git url> RS_BRANCH=<branch> bash -s -- [invite-code]
#
# Installs Git and Python with the system package manager if they are missing
# (asks for your password once), installs Bun for your user, downloads the
# game into ~/rs-sdk (RS_DIR to change), installs its packages and the Python
# rs package, and saves the invite's bot.env. Safe to run again: it updates.

set -euo pipefail

REPO="${RS_REPO:-https://github.com/MaxBittker/rs-sdk.git}"
BRANCH="${RS_BRANCH:-main}"
DIR="${RS_DIR:-$HOME/rs-sdk}"
INVITE="${1:-${RS_INVITE:-}}"

say() { printf '\033[1m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

as_root() {
    if [ "$(id -u)" = 0 ]; then "$@"
    elif have sudo; then sudo "$@"
    else die "Need administrator rights to run: $*"; fi
}

python_ok() {
    have python3 && python3 -c 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1
}

# ---- 1. System packages: git, python3 with venv, curl, unzip (for Bun) -------
missing=()
have git || missing+=(git)
python_ok || missing+=(python)
have curl || missing+=(curl)
have unzip || missing+=(unzip)

if [ ${#missing[@]} -gt 0 ]; then
    say "Installing ${missing[*]} (you may be asked for your password)..."
    if [ -e /etc/NIXOS ]; then
        die "On NixOS, add git, python3, curl and unzip to your configuration (or run inside: nix-shell -p git python3 curl unzip bun), then run this again."
    elif have apt-get; then
        as_root apt-get update -qq
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git python3 python3-venv python3-pip curl unzip ca-certificates >/dev/null
    elif have dnf; then
        as_root dnf install -y -q git python3 python3-pip curl unzip
    elif have pacman; then
        as_root pacman -Sy --noconfirm --needed git python python-pip curl unzip
    elif have zypper; then
        as_root zypper --non-interactive install git python3 python3-pip curl unzip
    elif have brew; then
        brew install git python curl unzip
    elif [ "$(uname)" = Darwin ]; then
        die "Install Homebrew (https://brew.sh) or the Xcode command line tools (xcode-select --install), then run this again."
    else
        die "Install ${missing[*]} with your system's package manager, then run this again."
    fi
    python_ok || die "Python 3.9 or newer with venv is still missing. Install it, then run this again."
fi

# ---- 2. Bun ------------------------------------------------------------------
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! have bun; then
    say "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash >/dev/null
    have bun || die "Bun did not install. See https://bun.sh"
fi

# ---- 3. The game -------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
    say "Updating the game in $DIR..."
    git -C "$DIR" pull --ff-only --quiet || say "Could not update (local changes?). Keeping your copy as it is."
else
    say "Downloading the game into $DIR..."
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

say "Installing packages..."
# Production only: the dev tools include puppeteer, which downloads a whole browser.
PUPPETEER_SKIP_DOWNLOAD=1 bun install --silent --production

say "Setting up Python..."
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --disable-pip-version-check -e python/

# ---- 4. Join -----------------------------------------------------------------
bot=""
if [ -n "$INVITE" ]; then
    out="$(bun join.ts "$INVITE")" || die "$out"
    printf '%s\n' "$out" | head -n 2
    bot="$(printf '%s\n' "$out" | sed -n 's/^Start playing:  bun play.ts //p')"
fi

cat <<EOF

Installed! To play:

  cd $DIR
  bun play.ts ${bot:-<your bot name>}

EOF
if ! grep -qs '.bun/bin' "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.config/fish/config.fish" 2>/dev/null; then
    say "If 'bun' is not found in a new terminal, run: export PATH=\"\$HOME/.bun/bin:\$PATH\""
fi
