#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

# The approved Labrastro installer is CLI-only and reads internal releases.
# Keep every download stubbed; an unexpected public URL, brew or docker fails.
mkdir -p "$test_dir/stubs" "$test_dir/payload"
cat >"$test_dir/payload/multica" <<'STUB'
#!/bin/sh
echo "multica v0.3.2"
STUB
chmod +x "$test_dir/payload/multica"
tar -czf "$test_dir/archive.tar.gz" -C "$test_dir/payload" multica
if command -v sha256sum >/dev/null; then
  archive_sha="$(sha256sum "$test_dir/archive.tar.gz" | cut -d' ' -f1)"
else
  archive_sha="$(shasum -a 256 "$test_dir/archive.tar.gz" | cut -d' ' -f1)"
fi

cat >"$test_dir/stubs/uname" <<'STUB'
#!/bin/sh
case "$1" in
  -s) echo "$INSTALL_TEST_OS" ;;
  -m) echo "$INSTALL_TEST_ARCH" ;;
  *) exit 95 ;;
esac
STUB
cat >"$test_dir/stubs/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$url" >>"$INSTALL_TEST_LOG"
case "$url" in
  "$INSTALL_TEST_BASE/latest.json")
    [ "$INSTALL_TEST_MODE" != "metadata-failure" ] || exit 22
    printf '{"version":"v0.3.2"}\n'
    ;;
  "$INSTALL_TEST_BASE/cli/v0.3.2/$INSTALL_TEST_ARCHIVE_NAME")
    [ -n "$out" ]
    cp "$INSTALL_TEST_ARCHIVE" "$out"
    ;;
  "$INSTALL_TEST_BASE/cli/v0.3.2/checksums.txt")
    [ "$INSTALL_TEST_MODE" != "missing-checksum" ] || exit 22
    checksum="$INSTALL_TEST_SHA"
    if [ "$INSTALL_TEST_MODE" = "bad-checksum" ]; then checksum=bad; fi
    printf '%s  %s\n' "$checksum" "$INSTALL_TEST_ARCHIVE_NAME" >"$out"
    ;;
  *)
    echo "unexpected download URL: $url" >&2
    exit 97
    ;;
esac
STUB
for command_name in brew docker sudo; do
  cat >"$test_dir/stubs/$command_name" <<'STUB'
#!/bin/sh
printf 'unexpected command %s\n' "$0" >>"$INSTALL_TEST_LOG"
echo "unexpected package manager, server, or privilege escalation" >&2
exit 98
STUB
done
chmod +x "$test_dir/stubs/"*

run_case() {
  local name="$1" os="$2" arch="$3" release_os="$4" release_arch="$5" mode="$6"
  local base="${7:-https://multica.outlune.com/downloads}"
  local case_dir="$test_dir/$name"
  mkdir -p "$case_dir/bin" "$case_dir/home"
  : >"$case_dir/downloads"
  # Failed installs must leave an existing binary untouched.
  if [ "$mode" = bad-checksum ] || [ "$mode" = metadata-failure ]; then
    printf '#!/bin/sh\necho "existing binary"\n' >"$case_dir/bin/multica"
    chmod +x "$case_dir/bin/multica"
  fi
  local status=0
  env -i \
    PATH="$case_dir/bin:$test_dir/stubs:/usr/bin:/bin" \
    HOME="$case_dir/home" \
    MULTICA_BIN_DIR="$case_dir/bin" \
    MULTICA_DOWNLOAD_BASE="${7:-}" \
    INSTALL_TEST_OS="$os" INSTALL_TEST_ARCH="$arch" \
    INSTALL_TEST_MODE="$mode" INSTALL_TEST_BASE="$base" \
    INSTALL_TEST_LOG="$case_dir/downloads" \
    INSTALL_TEST_ARCHIVE="$test_dir/archive.tar.gz" \
    INSTALL_TEST_ARCHIVE_NAME="multica-cli-0.3.2-$release_os-$release_arch.tar.gz" \
    INSTALL_TEST_SHA="$archive_sha" \
    bash "$ROOT_DIR/scripts/install.sh" >"$case_dir/out" 2>"$case_dir/err" || status=$?
  if grep -q 'unexpected command' "$case_dir/downloads"; then
    cat "$case_dir/downloads" >&2
    return 1
  fi
  case "$mode" in
    bad-checksum|metadata-failure)
      [ "$status" -ne 0 ]
      [ "$("$case_dir/bin/multica")" = "existing binary" ]
      if [ "$mode" = bad-checksum ]; then
        grep -q 'Checksum verification failed' "$case_dir/err"
      fi
      ;;
    unsupported)
      [ "$status" -ne 0 ]
      [ ! -s "$case_dir/downloads" ]
      grep -q 'Unsupported architecture' "$case_dir/err"
      ;;
    *)
      if [ "$status" -ne 0 ]; then
        cat "$case_dir/out" "$case_dir/err" >&2
        return 1
      fi
      [ "$("$case_dir/bin/multica")" = "multica v0.3.2" ]
      grep -Fq "$base/latest.json" "$case_dir/downloads"
      grep -Fq "$base/cli/v0.3.2/multica-cli-0.3.2-$release_os-$release_arch.tar.gz" "$case_dir/downloads"
      grep -Fq 'Labrastro CLI is ready' "$case_dir/out"
      grep -Fq 'multica.outlune.com' "$case_dir/out"
      if [ "$mode" = missing-checksum ]; then
        grep -q 'checksums.txt unavailable' "$case_dir/err"
      else
        grep -q 'Checksum verified' "$case_dir/out"
      fi
      ;;
  esac
  echo "PASS $name"
}

run_case linux-amd64 Linux x86_64 linux amd64 success
run_case linux-arm64 Linux aarch64 linux arm64 success
run_case mac-amd64 Darwin x86_64 darwin amd64 success
run_case mac-arm64 Darwin arm64 darwin arm64 success
run_case mirror Linux x86_64 linux amd64 success https://mirror.example.test/releases
run_case checksum-mismatch Linux x86_64 linux amd64 bad-checksum
run_case metadata-unavailable Linux x86_64 linux amd64 metadata-failure
run_case checksum-unavailable Linux x86_64 linux amd64 missing-checksum
run_case unsupported-arch Linux riscv64 linux riscv64 unsupported
echo "Labrastro internal install.sh tests passed"
