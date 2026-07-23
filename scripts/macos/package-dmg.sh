#!/usr/bin/env bash
# Build a distributable .dmg from an (already signed + stapled) .app, with an
# /Applications drop target. Prints the resulting dmg path on stdout.
#
# Usage:
#   scripts/macos/package-dmg.sh [path/to/Maestro.app] [out.dmg]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_env
require_cmd hdiutil

APP="${1:-$(find_app)}"
[[ -d "$APP" ]] || die "app bundle not found: $APP"
APP_NAME="$(basename "$APP" .app)"
OUT="${2:-$(bundle_dir)/dmg/${APP_NAME}.dmg}"
mkdir -p "$(dirname "$OUT")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

log "staging $APP_NAME"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

[[ -f "$OUT" ]] && rm -f "$OUT"
log "creating dmg: $OUT"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
log "dmg created: $OUT"
echo "$OUT"
