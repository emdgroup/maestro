#!/usr/bin/env bash
# Copies Tauri's version-stamped bundles into release/ under stable, version-free
# names, so the README download links stay valid across releases. Run once per
# build job with the platform slug, e.g. `stage-release-assets.sh linux_x86_64`.
set -euo pipefail
shopt -s nullglob

slug="${1:?usage: stage-release-assets.sh <platform-slug>}"
bundle="target/release/bundle"
out="release"

mkdir -p "$out"

# stage <stable-name> <glob>... — expects exactly one match, so a bundle that
# silently stopped being produced fails the job instead of the download link.
stage() {
  local dest="$1"
  shift

  if [ "$#" -ne 1 ]; then
    echo "Expected exactly one bundle for $dest, found $#: $*" >&2
    exit 1
  fi

  cp "$1" "$out/$dest"
  echo "$out/$dest  <-  $1"
}

case "$slug" in
  linux_*)
    stage "Maestro_${slug}.AppImage" $bundle/appimage/*.AppImage
    stage "Maestro_${slug}.AppImage.sig" $bundle/appimage/*.AppImage.sig
    stage "Maestro_${slug}.deb" $bundle/deb/*.deb
    ;;
  macos_*)
    stage "Maestro_${slug}.dmg" $bundle/dmg/*.dmg
    stage "Maestro_${slug}.app.tar.gz" $bundle/macos/*.app.tar.gz
    stage "Maestro_${slug}.app.tar.gz.sig" $bundle/macos/*.app.tar.gz.sig
    ;;
  windows_*)
    stage "Maestro_${slug}-setup.exe" $bundle/nsis/*-setup.exe
    stage "Maestro_${slug}-setup.exe.sig" $bundle/nsis/*-setup.exe.sig
    stage "Maestro_${slug}.msi" $bundle/msi/*.msi
    ;;
  *)
    echo "Unknown platform slug: $slug" >&2
    exit 1
    ;;
esac
