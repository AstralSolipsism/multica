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
DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"

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

# Legacy numeric versions are accepted only as installed migration inputs.
parse_release_version() {
  local pattern='^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-labrastro\.([1-9][0-9]*))?$'
  [[ "$1" =~ $pattern ]] || return 1
  RELEASE_PARTS=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[5]:-0}")
  [[ "${RELEASE_PARTS[*]}" != "0 0 0 "* ]]
}

is_newer_version() {
  parse_release_version "$1" || return 1
  local latest=("${RELEASE_PARTS[@]}")
  parse_release_version "$2" || return 1
  local i
  for i in 0 1 2 3; do
    if [ "${latest[$i]}" != "${RELEASE_PARTS[$i]}" ]; then
      if [ "${#latest[$i]}" != "${#RELEASE_PARTS[$i]}" ]; then
        [ "${#latest[$i]}" -gt "${#RELEASE_PARTS[$i]}" ]
      else
        [[ "${latest[$i]}" > "${RELEASE_PARTS[$i]}" ]]
      fi
      return
    fi
  done
  return 1
}

get_latest_version() {
  local manifest tag
  manifest=$(curl -fsSL "$DOWNLOAD_BASE/latest.json") || return 1
  tag=$(printf '%s\n' "$manifest" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
  parse_release_version "$tag" && [[ "$tag" == v*-labrastro.* ]] || return 1
  printf '%s\n' "$tag"
}

checksum_for() {
  awk -v name="$2" '
    { sub(/\r$/, "") }
    $2 == name || $2 == "*" name {
      count++; hash = tolower($1)
      if (NF != 2 || length(hash) != 64 || hash ~ /[^0-9a-f]/) invalid = 1
    }
    END {
      if (count == 0) exit 2
      if (count != 1 || invalid) exit 1
      print hash
    }' "$1"
}

binary_version() {
  "$1" --version | awk 'NR == 1 && $1 == "multica" { print $2 }'
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

install_cli_binary() (
  # A subshell owns cleanup even when a download, extraction or install fails.
  local tmp_dir="" staged="" bin_dir current latest version base_url archive expected actual candidate status
  # Use a nonempty command for macOS Bash 3.2 with nounset enabled.
  local install_cmd=env
  trap 'rm -rf "$tmp_dir"; if [ -n "$staged" ]; then "$install_cmd" rm -f "$staged"; fi' EXIT

  if command_exists multica; then
    current=$(binary_version multica) || fail "Could not read the installed CLI version; keeping the existing installation."
    parse_release_version "$current" || fail "Refusing to replace a development or unrecognized build ($current)."
  else
    current=""
  fi
  latest=$(get_latest_version) || fail "Could not read a valid Labrastro release from $DOWNLOAD_BASE/latest.json."
  if [ -n "$current" ] && ! is_newer_version "$latest" "$current"; then
    ok "Labrastro CLI is up to date ($current)"
    return
  fi

  info "Installing Labrastro CLI $latest from the internal release source..."
  version="${latest#v}"
  base_url="$DOWNLOAD_BASE/cli/$latest"
  tmp_dir=$(mktemp -d)
  curl -fsSL "$base_url/checksums.txt" -o "$tmp_dir/checksums.txt" || fail "Could not download checksums.txt; keeping the existing installation."
  archive=""
  for candidate in "multica-cli-$version-$OS-$ARCH.tar.gz" "multica_${OS}_${ARCH}.tar.gz"; do
    if expected=$(checksum_for "$tmp_dir/checksums.txt" "$candidate"); then
      archive="$candidate"
      break
    else
      status=$?
      [ "$status" -eq 2 ] || fail "Invalid or duplicate checksum for $candidate."
    fi
  done
  [ -n "$archive" ] || fail "No checksummed CLI archive for $OS/$ARCH."
  info "Downloading $base_url/$archive ..."
  curl -fsSL "$base_url/$archive" -o "$tmp_dir/archive.tar.gz" || fail "Failed to download the CLI archive."
  actual=$(sha256_of "$tmp_dir/archive.tar.gz")
  [ "$actual" = "$expected" ] || fail "Checksum verification failed for $archive."
  ok "Checksum verified"

  # Extract only the binary bytes, including older archives with a directory.
  local entry
  entry=$(tar -tzf "$tmp_dir/archive.tar.gz" | awk '/(^|\/)multica$/ { print; count++ } END { if (count != 1) exit 1 }') || fail "Archive must contain exactly one multica binary."
  tar -xOzf "$tmp_dir/archive.tar.gz" "$entry" > "$tmp_dir/multica"
  chmod +x "$tmp_dir/multica"
  actual=$(binary_version "$tmp_dir/multica") || fail "Downloaded CLI cannot run; keeping the existing installation."
  [ "${actual#v}" = "$version" ] || fail "Downloaded CLI version ($actual) does not match $latest."

  # Stage on the target filesystem, then rename, so a failed copy preserves the
  # working binary even when the download directory is on another filesystem.
  bin_dir="${MULTICA_BIN_DIR:-/usr/local/bin}"
  if [ ! -w "$bin_dir" ]; then
    if command_exists sudo; then
      install_cmd=sudo
    else
      bin_dir="$HOME/.local/bin"
      mkdir -p "$bin_dir"
      add_to_path "$bin_dir"
    fi
  fi
  staged=$("$install_cmd" mktemp "$bin_dir/.multica-install.XXXXXX")
  "$install_cmd" cp "$tmp_dir/multica" "$staged"
  "$install_cmd" chmod 755 "$staged"
  "$install_cmd" mv -f "$staged" "$bin_dir/multica"
  staged=""
  ok "Labrastro CLI installed to $bin_dir/multica"
)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
printf "\n"
printf "${BOLD}  Labrastro — CLI Installer${RESET}\n"
printf "\n"

detect_os
install_cli_binary

if ! command_exists multica && [ -x "$HOME/.local/bin/multica" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
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
