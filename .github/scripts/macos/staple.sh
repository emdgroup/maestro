#!/usr/bin/env bash
# Attach ("staple") the notarization ticket to an artifact and verify it, so
# Gatekeeper accepts it without an online check.
#
# Usage:
#   scripts/macos/staple.sh <path .app | .dmg | .pkg>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_env
require_cmd xcrun
require_cmd codesign
require_cmd spctl

ARTIFACT="${1:-}"
[[ -n "$ARTIFACT" ]] || die "usage: staple.sh <path to .app/.dmg/.pkg>"
[[ -e "$ARTIFACT" ]] || die "artifact not found: $ARTIFACT"

log "stapling ticket to $ARTIFACT"
xcrun stapler staple "$ARTIFACT"

log "validating staple"
xcrun stapler validate "$ARTIFACT"

# A stapled ticket is not sufficient if the bundle was modified after signing.
# Verify the final artifact before publishing it.
if [[ "$ARTIFACT" == *.app ]]; then
  log "verifying final app signature"
  codesign --verify --deep --strict --verbose=2 "$ARTIFACT"

  log "assessing app with Gatekeeper"
  spctl --assess --type execute --verbose=2 "$ARTIFACT"
else
  log "verifying final container signature"
  codesign --verify --verbose=2 "$ARTIFACT"

  log "assessing container with Gatekeeper"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$ARTIFACT"
fi
log "stapled OK: $ARTIFACT"
