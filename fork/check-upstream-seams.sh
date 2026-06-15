#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_REF="${1:-upstream/main}"
ALLOWLIST_FILE="$ROOT_DIR/fork/upstream-seams.allowlist"

cd "$ROOT_DIR"

if ! git rev-parse --verify "$UPSTREAM_REF" >/dev/null 2>&1; then
  echo "Missing upstream ref: $UPSTREAM_REF" >&2
  exit 1
fi

if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "Missing seam allowlist: $ALLOWLIST_FILE" >&2
  exit 1
fi

ALLOWLIST=()
while IFS= read -r path || [ -n "$path" ]; do
  case "$path" in
    "" | \#*) continue ;;
    *) ALLOWLIST+=("$path") ;;
  esac
done < "$ALLOWLIST_FILE"

is_allowed() {
  local path="$1"
  local allowed

  case "$path" in
    fork/*|README.md|.gitignore|.gitmodules)
      return 0
      ;;
  esac

  for allowed in "${ALLOWLIST[@]}"; do
    if [ "$path" = "$allowed" ]; then
      return 0
    fi
  done

  return 1
}

UNEXPECTED=()
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if ! is_allowed "$path"; then
    UNEXPECTED+=("$path")
  fi
done < <(git diff --name-only "$UPSTREAM_REF"..HEAD)

if [ "${#UNEXPECTED[@]}" -gt 0 ]; then
  echo "Unexpected fork differences outside owned paths:" >&2
  printf '  %s\n' "${UNEXPECTED[@]}" >&2
  exit 1
fi

for path in "${ALLOWLIST[@]}"; do
  if ! git diff --quiet "$UPSTREAM_REF"..HEAD -- "$path"; then
    if ! rg -q 'FORK-SEAM\(pi\)' "$path"; then
      echo "Missing FORK-SEAM(pi) marker: $path" >&2
      exit 1
    fi
  fi
done

echo "Fork ownership and upstream seam checks passed."
