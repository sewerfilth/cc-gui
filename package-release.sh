#!/usr/bin/env bash
# Build a signed cc-gui release.
#
# Stages cutecontainer-cli as a Tauri sidecar (with the platform-triple suffix
# Tauri expects), then runs `tauri build`. Signing identity is read from
# APPLE_SIGNING_IDENTITY — defaults to "-" (ad-hoc) so this works without an
# Apple Developer account. To produce a notarized build, export:
#
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   APPLE_API_KEY=<key-id>           # App Store Connect API key id
#   APPLE_API_ISSUER=<issuer-uuid>
#   APPLE_API_KEY_PATH=/path/to/AuthKey_<id>.p8
#
# Output:
#   src-tauri/target/release/bundle/macos/cc-gui.app
#   src-tauri/target/release/bundle/dmg/cc-gui_<version>_<arch>.dmg
set -euo pipefail

cd "$(dirname "$0")"

CLI_SRC="../cutecontainer/build/cutecontainer-cli"
if [[ ! -x "$CLI_SRC" ]]; then
  echo "error: $CLI_SRC not found or not executable" >&2
  echo "       build it first: (cd ../cutecontainer && ./build.sh)" >&2
  exit 1
fi

# Tauri sidecar naming: <name>-<rustc-target-triple>
TARGET_TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "error: could not determine rustc host triple" >&2
  exit 1
fi

STAGE_DIR="src-tauri/binaries"
STAGED="$STAGE_DIR/cutecontainer-cli-$TARGET_TRIPLE"

mkdir -p "$STAGE_DIR"
cp "$CLI_SRC" "$STAGED"
chmod +x "$STAGED"
echo "staged sidecar: $STAGED ($(file -b "$STAGED"))"

export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
echo "signing identity: $APPLE_SIGNING_IDENTITY"

npm run tauri -- build

APP="src-tauri/target/release/bundle/macos/cc-gui.app"
if [[ -d "$APP" ]]; then
  echo
  echo "verifying signature on $APP"
  codesign -dv --verbose=2 "$APP" 2>&1 | sed 's/^/  /' || true
  echo
  echo "gatekeeper assessment (will fail for ad-hoc signing — that is expected):"
  spctl -a -vv "$APP" 2>&1 | sed 's/^/  /' || true
fi
