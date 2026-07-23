# macOS signing & notarization

Scripts to sign, notarize, and staple Maestro's macOS build. Built for manual
runs first; the same scripts are reused from GitHub Actions later (they read
everything from environment variables / secrets).

## What you need

- **Developer ID Application certificate** as a `.p12` + its password
  (`APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`).
- **App Store Connect API key** for notarytool: the `.p8` file, its **Key ID**,
  and the **Issuer ID** (`APPLE_API_KEY_PATH`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`).
- Xcode command line tools (`xcrun`, `codesign`, `stapler`, `hdiutil`).

Copy `.env.example` to `.env` (gitignored) and fill it in.

## Why these steps, in this order

`pnpm tauri build` produces an **unsigned** `.app` and a `.dmg` that wraps an
unsigned copy of it. Notarization requires a Developer ID signature + hardened
runtime, so you can't notarize Tauri's dmg directly. The correct pipeline:

1. **sign** the `.app` (nested Mach-O binaries first, then the bundle)
2. **notarize** the `.app`, then **staple** the ticket onto it
3. **repackage** a fresh `.dmg` from the now-stapled `.app`
4. **notarize** the `.dmg`, then **staple** it

Stapling both means Gatekeeper accepts the app even offline. `release-macos.sh`
runs all six steps; the individual scripts let you do (or re-run) any one step.

## Usage

```bash
# 0. Build first
pnpm tauri build

# Everything at once:
scripts/macos/release-macos.sh

# …or step by step (each auto-detects the .app/.dmg if no path is given):
scripts/macos/sign.sh
scripts/macos/notarize.sh target/release/bundle/macos/Maestro.app
scripts/macos/staple.sh   target/release/bundle/macos/Maestro.app
DMG=$(scripts/macos/package-dmg.sh)
scripts/macos/notarize.sh "$DMG"
scripts/macos/staple.sh   "$DMG"
```

### Checking notarization status

`notarize.sh` waits for the verdict and prints the submission id. To inspect a
past submission:

```bash
scripts/macos/notarize.sh --status <submission-id>   # current state
scripts/macos/notarize.sh --log    <submission-id>   # full JSON log (why it failed)
scripts/macos/notarize.sh --history                  # recent submissions
```

### x86_64 cross build

Set `TARGET_TRIPLE=x86_64-apple-darwin` (or `BUNDLE_DIR=...`) so the scripts find
the right bundle dir.

## Verifying the result

```bash
codesign --verify --deep --strict --verbose=2 Maestro.app
xcrun stapler validate Maestro.dmg
spctl --assess --type open --context context:primary-signature -v Maestro.dmg
```

## GitHub Actions (next phase)

The scripts read all inputs from the environment, so wiring CI is just a matter
of providing these as repository secrets and exporting them before calling
`release-macos.sh`:

| Secret                         | Maps to                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `APPLE_CERTIFICATE_P12_BASE64` | base64 of the `.p12`                                                     |
| `APPLE_CERTIFICATE_PASSWORD`   | `.p12` password                                                          |
| `APPLE_API_KEY_BASE64`         | base64 of the `.p8` (decode to a file, point `APPLE_API_KEY_PATH` at it) |
| `APPLE_API_KEY_ID`             | Key ID                                                                   |
| `APPLE_API_ISSUER`             | Issuer ID                                                                |
