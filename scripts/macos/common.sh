#!/usr/bin/env bash
# Shared helpers for the macOS signing / notarization scripts.
# Sourced by the other scripts in this directory; not meant to run on its own.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log()  { printf '\033[1;34m[notarize]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[notarize] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[notarize] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Load env from repo-root .env then scripts/macos/.env (the latter wins).
load_env() {
  local f
  for f in "$REPO_ROOT/.env" "$SCRIPT_DIR/.env"; do
    if [[ -f "$f" ]]; then
      log "loading env from $f"
      set -a
      # shellcheck disable=SC1090
      source "$f"
      set +a
    fi
  done
}

require_var() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "required env var '$name' is not set (see scripts/macos/.env.example)"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH"
}

# Where the Tauri bundle lives. Override with BUNDLE_DIR, or TARGET_TRIPLE for
# cross builds (e.g. x86_64-apple-darwin).
bundle_dir() {
  if [[ -n "${BUNDLE_DIR:-}" ]]; then echo "$BUNDLE_DIR"; return; fi
  if [[ -n "${TARGET_TRIPLE:-}" ]]; then
    echo "$REPO_ROOT/target/$TARGET_TRIPLE/release/bundle"; return
  fi
  echo "$REPO_ROOT/target/release/bundle"
}

# find_one <dir> <glob>: print the single match; die on none, warn+first on many.
find_one() {
  local dir="$1" pat="$2"
  local matches=()
  while IFS= read -r -d '' m; do matches+=("$m"); done \
    < <(find "$dir" -maxdepth 1 -name "$pat" -print0 2>/dev/null)
  [[ ${#matches[@]} -gt 0 ]] || die "no '$pat' found in $dir (did you run 'pnpm tauri build'?)"
  [[ ${#matches[@]} -eq 1 ]] || warn "multiple '$pat' in $dir; using ${matches[0]}"
  echo "${matches[0]}"
}

find_app() { find_one "$(bundle_dir)/macos" '*.app'; }
find_dmg() { find_one "$(bundle_dir)/dmg" '*.dmg'; }
