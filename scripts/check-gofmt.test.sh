#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

printf 'package fixture\n\nfunc example() { println("formatted") }\n' > "$fixture/example.go"
bash "$repo_root/scripts/check-gofmt.sh" "$fixture"

printf 'package fixture\nfunc example(){println("unformatted")}\n' > "$fixture/example.go"
if bash "$repo_root/scripts/check-gofmt.sh" "$fixture" > "$fixture/result" 2>&1; then
  echo "Expected unformatted Go to fail" >&2
  exit 1
fi
grep -Fq "$fixture/example.go" "$fixture/result"
gofmt -w "$fixture/example.go"
bash "$repo_root/scripts/check-gofmt.sh" "$fixture"

printf 'package fixture\nfunc broken(\n' > "$fixture/example.go"
if bash "$repo_root/scripts/check-gofmt.sh" "$fixture" > "$fixture/result" 2>&1; then
  echo "Expected a gofmt parse error to fail" >&2
  exit 1
fi
echo "gofmt gate rejects unformatted and invalid Go; formatted Go passes."
