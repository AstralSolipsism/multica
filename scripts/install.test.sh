#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/stubs" "$test_dir/payload"
cat >"$test_dir/payload/multica" <<'STUB'
#!/bin/sh
printf 'multica %s (commit: fixture)\n' "$INSTALL_TEST_BINARY_VERSION"
STUB
chmod +x "$test_dir/payload/multica"
tar -czf "$test_dir/archive.tar.gz" -C "$test_dir/payload" multica
printf 'not an archive' > "$test_dir/invalid.tar.gz"
printf 'no binary' > "$test_dir/payload/README"
tar -czf "$test_dir/missing.tar.gz" -C "$test_dir/payload" README

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
out="" url=""
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
    printf '{"version":"%s"}\n' "$INSTALL_TEST_TAG"
    ;;
  "$INSTALL_TEST_BASE/cli/$INSTALL_TEST_TAG/checksums.txt")
    [ "$INSTALL_TEST_MODE" != "missing-checksum" ] || exit 22
    hash="$INSTALL_TEST_SHA" name="$INSTALL_TEST_ARCHIVE_NAME"
    case "$INSTALL_TEST_MODE" in
      bad-checksum) hash="$(printf '%064d' 0)" ;;
      malformed-checksum) hash=bad ;;
      missing-entry) name="$name.extra" ;;
      binary-checksum) name="*$name" ;;
    esac
    if [ "$INSTALL_TEST_MODE" = crlf-checksum ]; then
      printf '%s  %s\r\n' "$hash" "$name" >"$out"
    else
      printf '%s  %s\n' "$hash" "$name" >"$out"
    fi
    if [ "$INSTALL_TEST_MODE" = duplicate ]; then
      printf '%s  %s\n' "$hash" "$name" >>"$out"
    fi
    ;;
  "$INSTALL_TEST_BASE/cli/$INSTALL_TEST_TAG/$INSTALL_TEST_ARCHIVE_NAME")
    [ "$INSTALL_TEST_MODE" != "missing-archive" ] || exit 22
    cp "$INSTALL_TEST_ARCHIVE" "$out"
    ;;
  *) echo "unexpected download URL: $url" >&2; exit 97 ;;
esac
STUB
for command_name in brew docker sudo; do
  cat >"$test_dir/stubs/$command_name" <<'STUB'
#!/bin/sh
printf 'unexpected command %s\n' "$0" >>"$INSTALL_TEST_LOG"
exit 98
STUB
done
cat >"$test_dir/stubs/cp" <<'STUB'
#!/bin/sh
if [ "$INSTALL_TEST_MODE" = copy-failure ]; then
  case "$2" in
    */.multica-install.*) printf 'partial' > "$2"; exit 89 ;;
  esac
fi
exec /bin/cp "$@"
STUB
chmod +x "$test_dir/stubs/"*

run_case() {
  local name="$1" mode="$2" current="${3:-}" tag="${4:-v0.4.43-labrastro.10}"
  local os="${5:-Linux}" arch="${6:-x86_64}" release_os="${7:-linux}" release_arch="${8:-amd64}"
  local base="${9:-https://multica.outlune.com/downloads}"
  local case_dir="$test_dir/$name" archive="$test_dir/archive.tar.gz" binary_version="${tag#v}"
  local asset="multica-cli-${tag#v}-$release_os-$release_arch.tar.gz" hash
  [ "$mode" != legacy ] || asset="multica_${release_os}_${release_arch}.tar.gz"
  [ "$mode" != invalid-archive ] || archive="$test_dir/invalid.tar.gz"
  [ "$mode" != missing-binary ] || archive="$test_dir/missing.tar.gz"
  [ "$mode" != wrong-version ] || binary_version=0.4.43-labrastro.9
  if command -v sha256sum >/dev/null; then
    hash=$(sha256sum "$archive" | cut -d' ' -f1)
  else
    hash=$(shasum -a 256 "$archive" | cut -d' ' -f1)
  fi
  mkdir -p "$case_dir/bin" "$case_dir/home"
  : >"$case_dir/downloads"
  if [ -n "$current" ]; then
    printf '#!/bin/sh\necho "multica %s (commit: old)"\n' "$current" >"$case_dir/bin/multica"
    chmod +x "$case_dir/bin/multica"
    cp "$case_dir/bin/multica" "$case_dir/original"
  fi
  local status=0
  env -i PATH="$case_dir/bin:$test_dir/stubs:/usr/bin:/bin" HOME="$case_dir/home" \
    MULTICA_BIN_DIR="$case_dir/bin" MULTICA_DOWNLOAD_BASE="$base" \
    INSTALL_TEST_OS="$os" INSTALL_TEST_ARCH="$arch" INSTALL_TEST_TAG="$tag" \
    INSTALL_TEST_MODE="$mode" INSTALL_TEST_BASE="${base%/}" INSTALL_TEST_LOG="$case_dir/downloads" \
    INSTALL_TEST_ARCHIVE="$archive" INSTALL_TEST_ARCHIVE_NAME="$asset" INSTALL_TEST_SHA="$hash" \
    INSTALL_TEST_BINARY_VERSION="$binary_version" \
    bash "$ROOT_DIR/scripts/install.sh" >"$case_dir/out" 2>"$case_dir/err" || status=$?
  if grep -q 'unexpected' "$case_dir/downloads" "$case_dir/err"; then
    cat "$case_dir/downloads" "$case_dir/err" >&2; return 1
  fi
  case "$mode" in
    success|legacy|binary-checksum|crlf-checksum)
      if [ "$status" -ne 0 ]; then cat "$case_dir/out" "$case_dir/err" >&2; return 1; fi
      cmp "$test_dir/payload/multica" "$case_dir/bin/multica"
      [ -x "$case_dir/bin/multica" ]
      grep -Fq "${base%/}/cli/$tag/$asset" "$case_dir/downloads"
      grep -Fq 'Labrastro CLI is ready' "$case_dir/out"
      grep -Fq 'Checksum verified' "$case_dir/out"
      ;;
    unchanged)
      [ "$status" -eq 0 ]
      cmp "$case_dir/original" "$case_dir/bin/multica"
      [ "$(wc -l < "$case_dir/downloads" | tr -d ' ')" = 1 ]
      ;;
    *)
      if [ "$status" -eq 0 ]; then echo "$name unexpectedly succeeded" >&2; return 1; fi
      if [ -n "$current" ]; then cmp "$case_dir/original" "$case_dir/bin/multica"; else [ ! -e "$case_dir/bin/multica" ]; fi
      case "$mode" in
        dev|unsupported) [ ! -s "$case_dir/downloads" ] ;;
        invalid-version|metadata-failure) [ "$(wc -l < "$case_dir/downloads" | tr -d ' ')" = 1 ] ;;
        missing-checksum|missing-entry|malformed-checksum|duplicate) [ "$(wc -l < "$case_dir/downloads" | tr -d ' ')" = 2 ] ;;
      esac
      ;;
  esac
  if compgen -G "$case_dir/bin/.multica-install.*" >/dev/null; then echo "$name left staged files" >&2; return 1; fi
  echo "PASS $name"
}

run_case linux-amd64 success
run_case linux-arm64 success '' v0.4.43-labrastro.10 Linux aarch64 linux arm64
run_case mac-amd64 success '' v0.4.43-labrastro.10 Darwin x86_64 darwin amd64
run_case mac-arm64 success '' v0.4.43-labrastro.10 Darwin arm64 darwin arm64
run_case mirror success '' v0.4.43-labrastro.10 Linux x86_64 linux amd64 https://mirror.example.test/downloads/
run_case numeric-revision success v0.4.43-labrastro.9
run_case base-bump success v0.4.42-labrastro.99
run_case legacy-migration success v0.4.43
run_case legacy-filename legacy v0.4.43-labrastro.9
run_case binary-checksum binary-checksum v0.4.43-labrastro.9
run_case crlf-checksum crlf-checksum v0.4.43-labrastro.9
run_case same-version unchanged 0.4.43-labrastro.10
run_case newer-installed unchanged v0.4.43-labrastro.11
run_case newer-base-installed unchanged v0.4.44-labrastro.1
run_case dirty-protected dev v0.4.43-labrastro.9-dirty
run_case describe-protected dev v0.4.43-labrastro.9-3-gabc1234
run_case unknown-protected dev dev
for mode in missing-checksum missing-entry malformed-checksum duplicate missing-archive bad-checksum wrong-version invalid-archive missing-binary copy-failure metadata-failure; do
  run_case "$mode" "$mode" v0.4.43-labrastro.9
done
for tag in v0.4.43 v0.0.0-labrastro.1 v0.4.43-labrastro.0 v0.4.43-labrastro.01 v0.4.43-labrastro.10-dirty v0.4.43-labrastro.10-2-gabc v0.4.43-beta.1 ../bad; do
  run_case "invalid-$RANDOM" invalid-version v0.4.43-labrastro.9 "$tag"
done
run_case unsupported unsupported '' v0.4.43-labrastro.10 Linux riscv64 linux riscv64
echo "Labrastro internal install.sh tests passed"
