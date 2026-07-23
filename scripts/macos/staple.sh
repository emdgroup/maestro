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

ARTIFACT="${1:-}"
[[ -n "$ARTIFACT" ]] || die "usage: staple.sh <path to .app/.dmg/.pkg>"
[[ -e "$ARTIFACT" ]] || die "artifact not found: $ARTIFACT"

log "stapling ticket to $ARTIFACT"
xcrun stapler staple "$ARTIFACT"

log "validating staple"
xcrun stapler validate "$ARTIFACT"

# Independent Gatekeeper assessment: apps are 'execute', disk images are 'open'.
if [[ "$ARTIFACT" == *.app ]]; then
  spctl --assess --type execute --verbose=2 "$ARTIFACT" || warn "spctl assessment reported issues"
else
  spctl --assess --type open --context context:primary-signature --verbose=2 "$ARTIFACT" \
    || warn "spctl assessment reported issues"
fi
log "stapled OK: $ARTIFACT"
