#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts" "$fixture/server/"{cmd,internal/fixture,pkg/fixture}
cd "$fixture"

expect_failure() {
  if bash "$repo_root/scripts/check-gofmt.sh" > "$fixture/result" 2>&1; then
    echo "Expected gofmt gate to fail: $1" >&2
    exit 1
  fi
  grep -Fq "$1" "$fixture/result"
}

manifest=scripts/gofmt-upstream-exceptions.txt
printf '# No upstream exceptions yet.\n' > "$manifest"

# Cover the root, cmd/, nested tests and paths containing spaces. Every call
# uses the same no-argument command as CI, without any repository history.
for file in server/example.go server/cmd/example.go \
  server/internal/fixture/example_test.go 'server/pkg/fixture/space name.go'; do
  printf 'package fixture\n\nfunc example() { println("formatted") }\n' > "$file"
  bash "$repo_root/scripts/check-gofmt.sh"

  printf 'package fixture\nfunc example(){println("unformatted")}\n' > "$file"
  cp "$file" "$fixture/before"
  expect_failure "$file"
  cmp "$file" "$fixture/before"
  gofmt -w "$file"
  bash "$repo_root/scripts/check-gofmt.sh"

  printf 'package fixture\nfunc broken(\n' > "$file"
  expect_failure "$file"
  rm "$file"
done

upstream=server/internal/fixture/upstream_test.go
printf 'package fixture\nfunc upstream(){println("original")}\n' > "$upstream"
cp "$upstream" "$fixture/original"
blob="$(git hash-object --no-filters -- "$upstream")"
printf '# Unmodified upstream snapshot.\n\n%s %s\n' "$blob" "$upstream" > "$manifest"
bash "$repo_root/scripts/check-gofmt.sh"
cmp "$upstream" "$fixture/original"

# A matching exception must not suppress another fork file (even identical bytes).
cp "$upstream" server/pkg/fixture/fork.go
expect_failure server/pkg/fixture/fork.go
gofmt -w server/pkg/fixture/fork.go
bash "$repo_root/scripts/check-gofmt.sh"

# Same basename in another directory is a different file and stays checked.
cp "$upstream" server/pkg/fixture/upstream_test.go
expect_failure server/pkg/fixture/upstream_test.go
rm server/pkg/fixture/upstream_test.go

# Editing an exempted upstream path puts it back under the gate automatically.
printf 'package fixture\nfunc upstream(){println("fork edit")}\n' > "$upstream"
expect_failure "$upstream"
gofmt -w "$upstream"
bash "$repo_root/scripts/check-gofmt.sh"
printf 'package fixture\nfunc broken(\n' > "$upstream"
expect_failure "$upstream"
cp "$fixture/original" "$upstream"
bash "$repo_root/scripts/check-gofmt.sh"

# Stale entries for removed files are harmless. Leave only formatted files in
# the tree so an unrelated gofmt failure cannot mask invalid-manifest handling.
mv "$upstream" "$fixture/upstream"
bash "$repo_root/scripts/check-gofmt.sh"

# A missing or invalid manifest must fail, not silently disable the check.
mv "$manifest" "$fixture/manifest"
expect_failure "$manifest"
for entry in "g${blob:1} $upstream" "${blob:1} $upstream" \
  "$blob $upstream extra" "$blob pkg/fixture/upstream_test.go" \
  "$blob server/internal/fixture/*.go"; do
  printf '%s\n' "$entry" > "$manifest"
  expect_failure 'Invalid gofmt upstream exception'
done
mv "$fixture/manifest" "$manifest"
mv "$fixture/upstream" "$upstream"

# The last exception still applies when its line has no trailing newline.
printf '%s %s' "$blob" "$upstream" > "$manifest"
bash "$repo_root/scripts/check-gofmt.sh"
cmp "$upstream" "$fixture/original"
echo "gofmt gate checks fork changes, preserves exact upstream snapshots and rejects invalid Go."
