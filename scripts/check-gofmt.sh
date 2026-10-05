#!/usr/bin/env bash
set -euo pipefail

# Only exact upstream snapshots are exempt. A fork edit at the same path must
# be formatted, without fetching upstream history in CI or rewriting originals.
find_args=(server -type f -name '*.go')
while read -r blob path extra || [[ -n "$blob" ]]; do
  [[ -z "$blob" || "$blob" == \#* ]] && continue
  # Paths must be literal: find's -path interprets glob metacharacters.
  if [[ ! "$blob" =~ ^[0-9a-f]{40}$ || ! "$path" =~ ^server/[a-zA-Z0-9_./-]+\.go$ || -n "$extra" ]]; then
    printf 'Invalid gofmt upstream exception: %s %s %s\n' "$blob" "$path" "$extra" >&2
    exit 1
  fi
  if [[ -f "$path" ]]; then
    actual="$(git hash-object --no-filters -- "$path")"
    if [[ "$actual" == "$blob" ]]; then
      find_args+=('!' -path "$path")
    fi
  fi
done < scripts/gofmt-upstream-exceptions.txt

# -exec ... + preserves filename boundaries and propagates formatter failures.
# It also avoids invoking gofmt on stdin when every file is exempt.
unformatted="$(find "${find_args[@]}" -exec gofmt -l {} +)"
if [[ -n "$unformatted" ]]; then
  printf 'Go files need gofmt:\n%s\n' "$unformatted" >&2
  exit 1
fi
