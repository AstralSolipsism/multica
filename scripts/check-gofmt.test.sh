#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/server/cmd"
cd "$fixture"

printf 'package fixture\n\nfunc example() { println("formatted") }\n' > server/example.go
cp server/example.go server/cmd/example.go
bash "$repo_root/scripts/check-gofmt.sh"

# This file is outside cmd/: narrowing the default scan must fail this test.
printf 'package fixture\nfunc example(){println("unformatted")}\n' > server/example.go
if bash "$repo_root/scripts/check-gofmt.sh" > "$fixture/result" 2>&1; then
  echo "Expected unformatted Go to fail" >&2
  exit 1
fi
grep -Fq 'server/example.go' "$fixture/result"
gofmt -w server/example.go
bash "$repo_root/scripts/check-gofmt.sh"

printf 'package fixture\nfunc broken(\n' > server/example.go
if bash "$repo_root/scripts/check-gofmt.sh" > "$fixture/result" 2>&1; then
  echo "Expected a gofmt parse error to fail" >&2
  exit 1
fi
echo "gofmt gate rejects unformatted and invalid Go; formatted Go passes."
