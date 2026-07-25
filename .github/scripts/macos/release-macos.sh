#!/usr/bin/env bash
# End-to-end macOS release: sign the .app, notarize + staple it, repackage a
# .dmg from the stapled app, then notarize + staple the .dmg.
#
# Run after `pnpm tauri build`. The result is a fully notarized, stapled dmg in
# which the contained app is also stapled (so offline first-launch works).
#
# Usage:
#   scripts/macos/release-macos.sh [path/to/Maestro.app]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_env

APP="${1:-$(find_app)}"

log "=== 1/7 sign app ==="
"$SCRIPT_DIR/sign.sh" "$APP"

log "=== 2/7 notarize app ==="
"$SCRIPT_DIR/notarize.sh" "$APP"

log "=== 3/7 staple app ==="
"$SCRIPT_DIR/staple.sh" "$APP"

log "=== 4/7 package dmg ==="
DMG="$("$SCRIPT_DIR/package-dmg.sh" "$APP")"

log "=== 5/7 sign dmg ==="
"$SCRIPT_DIR/sign.sh" "$DMG"

log "=== 6/7 notarize dmg ==="
"$SCRIPT_DIR/notarize.sh" "$DMG"

log "=== 7/7 staple dmg ==="
"$SCRIPT_DIR/staple.sh" "$DMG"

log "done — distributable dmg: $DMG"
