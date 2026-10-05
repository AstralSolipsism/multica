#!/usr/bin/env bash
set -euo pipefail

unformatted="$(gofmt -l server/)"
if [[ -n "$unformatted" ]]; then
  printf 'Go files need gofmt:\n%s\n' "$unformatted" >&2
  exit 1
fi
