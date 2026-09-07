#!/usr/bin/env bash
# Labrastro CLI installer — internal release source (multica.outlune.com).
#
# Install / upgrade the CLI:
#   curl -fsSL https://multica.outlune.com/downloads/install.sh | bash
#
# After installation, run `multica setup` to connect to multica.outlune.com.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DOWNLOAD_BASE="${MULTICA_DOWNLOAD_BASE:-https://multica.outlune.com/downloads}"

# Colors (disabled when not a terminal)
if [ -t 1 ] || [ -t 2 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "${BOLD}${CYAN}==> %s${RESET}\n" "$*"; }
ok()    { printf "${BOLD}${GREEN}✓ %s${RESET}\n" "$*"; }
warn()  { printf "${BOLD}${YELLOW}⚠ %s${RESET}\n" "$*" >&2; }
fail()  { printf "${BOLD}${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

sha256_of() {
  local file=$1
  if command_exists sha256sum; then
    sha256sum "$file" | cut -d' ' -f1
  elif command_exists shasum; then
    shasum -a 256 "$file" | cut -d' ' -f1
  else
    fail "Neither sha256sum nor shasum is available; cannot verify downloads."
  fi
}

detect_os() {
  case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *)      fail "Unsupported operating system: $(uname -s). This installer supports macOS and Linux." ;;
  esac

  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    arm64)   ARCH="arm64" ;;
    *)       fail "Unsupported architecture: $ARCH" ;;
  esac
}

get_latest_version() {
  curl -fsSL "$DOWNLOAD_BASE/latest.json" 2>/dev/null \
    | sed -n 's/.*"version"[: ]*"\([^"]*\)".*/\1/p' | head -n1
}

add_to_path() {
  local dir=$1
  local line="export PATH=\"$dir:\$PATH\""
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && ! grep -qF "$dir" "$rc"; then
      printf '\n# Added by Labrastro installer\n%s\n' "$line" >> "$rc"
    fi
  done
}

install_cli_binary() {
  info "Installing Labrastro CLI from the internal release source..."

  local latest
  latest=$(get_latest_version)
  if [ -z "$latest" ]; then
    fail "Could not determine the latest version from $DOWNLOAD_BASE/latest.json. Check your network connection."
  fi

  local version="${latest#v}"
  local base_url="$DOWNLOAD_BASE/cli/v$version"
  local archive="multica-cli-$version-$OS-$ARCH.tar.gz"
  local url="$base_url/$archive"
  local tmp_dir
  tmp_dir=$(mktemp -d)

  info "Downloading $url ..."
  if ! curl -fsSL "$url" -o "$tmp_dir/$archive"; then
    rm -rf "$tmp_dir"
    fail "Failed to download the CLI archive."
  fi

  # Integrity: verify against checksums.txt published next to the archive.
  if curl -fsSL "$base_url/checksums.txt" -o "$tmp_dir/checksums.txt"; then
    local expected actual
    expected=$(grep -F " $archive" "$tmp_dir/checksums.txt" | head -n1 | cut -d' ' -f1)
    actual=$(sha256_of "$tmp_dir/$archive")
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
      rm -rf "$tmp_dir"
      fail "Checksum verification failed for $archive."
    fi
    ok "Checksum verified"
  else
    warn "checksums.txt unavailable; skipping integrity verification."
  fi

  tar -xzf "$tmp_dir/$archive" -C "$tmp_dir" multica

  # Try /usr/local/bin first, fall back to ~/.local/bin. Scripted installs can
  # override the first choice with MULTICA_BIN_DIR.
  local bin_dir="${MULTICA_BIN_DIR:-/usr/local/bin}"
  if [ -w "$bin_dir" ]; then
    mv "$tmp_dir/multica" "$bin_dir/multica"
  elif command_exists sudo; then
    sudo mv "$tmp_dir/multica" "$bin_dir/multica"
  else
    bin_dir="$HOME/.local/bin"
    mkdir -p "$bin_dir"
    mv "$tmp_dir/multica" "$bin_dir/multica"
    chmod +x "$bin_dir/multica"
    if ! echo "$PATH" | tr ':' '\n' | grep -q "^$bin_dir$"; then
      export PATH="$bin_dir:$PATH"
      add_to_path "$bin_dir"
    fi
  fi

  rm -rf "$tmp_dir"
  ok "Labrastro CLI installed to $bin_dir/multica"
}

upgrade_cli_if_available() {
  command_exists multica || return 0
  local current_ver latest_ver
  current_ver=$(multica --version 2>/dev/null | head -n1 | sed 's/^[^0-9]*//' || true)
  latest_ver=$(get_latest_version)
  [ -n "$latest_ver" ] || return 0
  local latest_cmp="${latest_ver#v}"
  if [ -n "$current_ver" ] && [ "$current_ver" != "$latest_cmp" ]; then
    info "Labrastro CLI $current_ver installed, latest is $latest_cmp — upgrading..."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
printf "\n"
printf "${BOLD}  Labrastro — CLI Installer${RESET}\n"
printf "\n"

detect_os
upgrade_cli_if_available
install_cli_binary

if ! command_exists multica; then
  fail "CLI installed but 'multica' not found on PATH. You may need to restart your shell."
fi

printf "\n"
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  ✓ Labrastro CLI is ready!${RESET}\n"
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "\n"
printf "  ${BOLD}Next: connect to the internal server${RESET}\n"
printf "\n"
printf "     ${CYAN}multica setup${RESET}   # defaults to https://multica.outlune.com\n"
printf "\n"
