#!/usr/bin/env bash
# Code-sign a Maestro artifact with a Developer ID Application cert. An .app is
# signed inner-to-outer with hardened runtime + entitlements (so it can be
# notarized); a .dmg/.pkg container is signed flat (so 'spctl --assess' accepts
# it as a Notarized Developer ID artifact once stapled).
#
# Usage:
#   scripts/macos/sign.sh [path/to/Maestro.app | path/to/Maestro.dmg]
# If no path is given, auto-detects the .app under the Tauri bundle dir.
#
# Env (see .env.example):
#   APPLE_SIGNING_IDENTITY        e.g. "Developer ID Application: Jane Doe (TEAMID)"
#   APPLE_CERTIFICATE_P12         (optional) .p12 to import into a temp keychain
#   APPLE_CERTIFICATE_P12_BASE64  (optional) base64 of the .p12 (CI-friendly)
#   APPLE_CERTIFICATE_PASSWORD    password for the .p12 (required if importing)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_env
require_cmd codesign
require_cmd security

TARGET="${1:-$(find_app)}"
[[ -e "$TARGET" ]] || die "target not found: $TARGET"
ENTITLEMENTS="${ENTITLEMENTS:-$SCRIPT_DIR/entitlements.plist}"

TMP_KEYCHAIN=""
cleanup() {
  if [[ -n "$TMP_KEYCHAIN" ]]; then
    security delete-keychain "$TMP_KEYCHAIN" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Resolve the signing identity as a SHA-1 hash. Signing by hash is unambiguous
# even when the same Developer ID cert appears several times across keychains
# (e.g. multiple copies in the login keychain, or a CI import) — signing by name
# fails with "ambiguous (matches ...)".
is_hash() { [[ "$1" =~ ^[0-9A-Fa-f]{40}$ ]]; }

# Resolve a Developer ID Application identity to its SHA-1 hash. $1 = optional
# name substring to match (empty = first one); $2 = optional keychain to search.
hash_for() {
  local want="${1:-}" kc="${2:-}"
  # shellcheck disable=SC2086
  security find-identity -v -p codesigning ${kc:+"$kc"} 2>/dev/null \
    | awk -v want="$want" \
        'index($0, "Developer ID Application") && (want == "" || index($0, want)) {print $2; exit}'
}

# Honor an explicit hash as-is; resolve a name (or auto-pick) to a hash so that
# duplicate copies of the same cert can't make codesign ambiguous.
SIGN_ID=""
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]] && is_hash "${APPLE_SIGNING_IDENTITY}"; then
  SIGN_ID="$APPLE_SIGNING_IDENTITY"
else
  SIGN_ID="$(hash_for "${APPLE_SIGNING_IDENTITY:-}" || true)"
fi

# Only import the .p12 when no identity is already installed (the CI case).
# Locally the cert usually already lives in the login keychain; importing it
# again would create a duplicate and make codesign ambiguous.
if [[ -z "$SIGN_ID" && ( -n "${APPLE_CERTIFICATE_P12:-}" || -n "${APPLE_CERTIFICATE_P12_BASE64:-}" ) ]]; then
  require_var APPLE_CERTIFICATE_PASSWORD
  p12_path="${APPLE_CERTIFICATE_P12:-}"
  tmp_p12=""
  if [[ -z "$p12_path" ]]; then
    tmp_p12="$(mktemp -t maestro_cert_XXXXXX).p12"
    echo "$APPLE_CERTIFICATE_P12_BASE64" | base64 --decode > "$tmp_p12"
    p12_path="$tmp_p12"
  fi
  [[ -f "$p12_path" ]] || die "p12 not found: $p12_path"

  kc_pw="maestro-temp-$$"
  TMP_KEYCHAIN="$HOME/Library/Keychains/maestro-notarize-$$.keychain-db"
  log "no installed identity found — importing .p12 into a temporary keychain"
  security create-keychain -p "$kc_pw" "$TMP_KEYCHAIN"
  security set-keychain-settings -lut 21600 "$TMP_KEYCHAIN"
  security unlock-keychain -p "$kc_pw" "$TMP_KEYCHAIN"
  security import "$p12_path" -k "$TMP_KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security
  # Allow codesign to use the imported key without an interactive prompt.
  security set-key-partition-list -S apple-tool:,apple: -s -k "$kc_pw" "$TMP_KEYCHAIN" >/dev/null
  # Add our keychain to the search list so the identity is discoverable.
  existing_keychains="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$TMP_KEYCHAIN" $existing_keychains
  [[ -n "$tmp_p12" ]] && rm -f "$tmp_p12"
  SIGN_ID="$(hash_for "${APPLE_SIGNING_IDENTITY:-}" "$TMP_KEYCHAIN" || true)"
fi

[[ -n "$SIGN_ID" ]] || die "no Developer ID Application identity found (install the cert, or set APPLE_CERTIFICATE_P12 / APPLE_SIGNING_IDENTITY)"
log "signing identity: $SIGN_ID"
log "target: $TARGET"

if [[ -d "$TARGET" && "$TARGET" == *.app ]]; then
  [[ -f "$ENTITLEMENTS" ]] || die "entitlements not found: $ENTITLEMENTS"

  sign_one() {
    codesign --force --timestamp --options runtime \
      --entitlements "$ENTITLEMENTS" \
      --sign "$SIGN_ID" "$1"
  }

  # Sign inner-to-outer: every nested Mach-O first (e.g. the bundled macOS
  # maestro-server and any dylibs), then the bundle itself. The bundled Linux
  # maestro-server under remote/ is an ELF, not Mach-O, so it's left as a sealed
  # resource. --deep is deprecated and unreliable, so we walk explicitly.
  log "signing nested Mach-O binaries"
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q 'Mach-O'; then
      log "  sign $f"
      sign_one "$f"
    fi
  done < <(find "$TARGET/Contents" -type f -print0)

  log "signing app bundle"
  sign_one "$TARGET"

  log "verifying signature"
  codesign --verify --deep --strict --verbose=2 "$TARGET"
else
  # A .dmg / .pkg container: sign it flat. Hardened runtime and entitlements
  # apply only to executables, not disk images, so they're omitted here.
  log "signing container"
  codesign --force --timestamp --sign "$SIGN_ID" "$TARGET"
  codesign --verify --verbose=2 "$TARGET"
fi

log "signed OK: $TARGET"
