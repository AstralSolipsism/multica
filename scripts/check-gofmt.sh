#!/usr/bin/env bash
set -euo pipefail

# An optional directory lets the regression test use disposable Go files.
unformatted="$(gofmt -l "${1:-server/}")"
if [[ -n "$unformatted" ]]; then
  printf 'Go files need gofmt:\n%s\n' "$unformatted" >&2
  exit 1
fi
