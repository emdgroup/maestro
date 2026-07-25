#!/usr/bin/env bash
# Submit an artifact to Apple's notary service and wait for the verdict, or query
# an existing submission. Uses an App Store Connect API key (Key ID + Issuer ID).
#
# Usage:
#   scripts/macos/notarize.sh <path .app | .dmg | .zip | .pkg>   # submit + wait
#   scripts/macos/notarize.sh --status <submission-id>           # query status
#   scripts/macos/notarize.sh --log    <submission-id>           # fetch JSON log
#   scripts/macos/notarize.sh --history                          # recent submissions
#
# A raw .app is zipped automatically before submission. Notarization records the
# verdict against the artifact's code signature on Apple's servers; run
# staple.sh afterwards to attach the ticket for offline verification.
#
# Env (see .env.example):
#   APPLE_API_KEY_PATH   path to the .p8 private key
#   APPLE_API_KEY_ID     the Key ID
#   APPLE_API_ISSUER     the Issuer ID
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_env
require_cmd xcrun
require_cmd ditto

require_var APPLE_API_KEY_PATH
require_var APPLE_API_KEY_ID
require_var APPLE_API_ISSUER
[[ -f "$APPLE_API_KEY_PATH" ]] || die "API key not found: $APPLE_API_KEY_PATH"

auth=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")

case "${1:-}" in
  --status)
    shift; [[ -n "${1:-}" ]] || die "usage: notarize.sh --status <submission-id>"
    exec xcrun notarytool info "$1" "${auth[@]}" ;;
  --log)
    shift; [[ -n "${1:-}" ]] || die "usage: notarize.sh --log <submission-id>"
    exec xcrun notarytool log "$1" "${auth[@]}" ;;
  --history)
    exec xcrun notarytool history "${auth[@]}" ;;
  "")
    die "usage: notarize.sh <path | --status ID | --log ID | --history>" ;;
esac

ARTIFACT="$1"
[[ -e "$ARTIFACT" ]] || die "artifact not found: $ARTIFACT"

# notarytool accepts .dmg/.pkg/.zip; a raw .app bundle must be zipped first.
SUBMIT="$ARTIFACT"
TMP_DIR=""
if [[ -d "$ARTIFACT" && "$ARTIFACT" == *.app ]]; then
  TMP_DIR="$(mktemp -d)"
  SUBMIT="$TMP_DIR/$(basename "$ARTIFACT" .app).zip"
  log "zipping app for submission: $SUBMIT"
  ditto -c -k --keepParent "$ARTIFACT" "$SUBMIT"
fi
trap '[[ -n "$TMP_DIR" ]] && rm -rf "$TMP_DIR"' EXIT

log "submitting $SUBMIT (this can take a few minutes)…"
set +e
out="$(xcrun notarytool submit "$SUBMIT" "${auth[@]}" --wait --output-format json 2>&1)"
code=$?
set -e
echo "$out"
[[ $code -eq 0 ]] || die "notarytool submit failed"

# Parse id + status from the JSON without requiring jq.
id="$(echo "$out" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
status="$(echo "$out" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | tail -1)"
log "submission id: ${id:-unknown}  status: ${status:-unknown}"

if [[ "$status" != "Accepted" ]]; then
  warn "not accepted — fetching detailed log"
  [[ -n "$id" ]] && xcrun notarytool log "$id" "${auth[@]}" || true
  die "notarization status: ${status:-unknown}"
fi
log "notarization accepted: $ARTIFACT"
