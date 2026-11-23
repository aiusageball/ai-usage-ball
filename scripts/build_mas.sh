#!/bin/bash
# Mac App Store (MAS) build script for AI Usage Ball.
#
# Builds:
#   1. PyInstaller onedir backend sidecar (copied to src-tauri/resources/aipulse-server)
#   2. Sandboxed Tauri MAS bundle (`VITE_APP_STORE=true`, Cargo `--no-default-features --features mas`)
#   3. Nested Mach-O child codesign (`entitlements.mas.child.plist`) + main app codesign (`entitlements.mas.plist`)
#   4. `.pkg` installer via `productbuild` when `APPLE_MAS_APP_CERT` and `APPLE_MAS_INSTALLER_CERT` are set.
#
# Usage:
#   APPLE_MAS_APP_CERT="3rd Party Mac Developer Application: ..." \
#   APPLE_MAS_INSTALLER_CERT="3rd Party Mac Developer Installer: ..." \
#   MAS_PROVISION_PROFILE="/path/to/AIUsageBall_MAS.provisionprofile" \
#   ./scripts/build_mas.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD="$REPO_ROOT/dashboard"
SRC_TAURI="$DASHBOARD/src-tauri"
MAS_ENTITLEMENTS="$SRC_TAURI/entitlements.mas.plist"
CHILD_ENTITLEMENTS="$SRC_TAURI/entitlements.mas.child.plist"
APP_VERSION="$(node -p "require('$SRC_TAURI/tauri.conf.json').version")"

echo "==> 1/5 Rebuilding PyInstaller onedir backend sidecar"
SERVER_DIR="$REPO_ROOT/server"
DIST_DIR="$HOME/Library/Application Support/AIPulse/dist-mas"
(
  cd "$SERVER_DIR"
  rm -rf "$DIST_DIR/aipulse-server" "$DIST_DIR/build"
  pyinstaller --onedir --name aipulse-server \
    --distpath "$DIST_DIR" --workpath "$DIST_DIR/build" \
    --collect-all uvicorn --collect-all fastapi --collect-all zeroconf \
    --collect-all anyio \
    --add-data "$DASHBOARD/public/liquid-loop.mp4:." --noconfirm \
    server.py
)

echo "==> 2/5 Copying sidecar into src-tauri/resources/aipulse-server"
RESOURCES="$SRC_TAURI/resources/aipulse-server"
rm -rf "$RESOURCES"
mkdir -p "$SRC_TAURI/resources"
cp -RL "$DIST_DIR/aipulse-server" "$RESOURCES"

echo "==> 3/5 Building Tauri MAS app bundle"
(
  cd "$DASHBOARD"
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  npm run tauri:build:mas
)

APP="$SRC_TAURI/target/release/bundle/macos/AI Usage Ball.app"
if [[ ! -d "$APP" ]]; then
  echo "ERROR: Expected app bundle not found at $APP" >&2
  exit 1
fi

echo "==> 4/5 Repairing Python.framework symlink (if present)"
PYFW="$APP/Contents/Resources/backend/_internal/Python.framework/Python"
if [[ -e "$PYFW" || -L "$PYFW" ]]; then
  rm -f "$PYFW"
  ln -s "Versions/Current/Python" "$PYFW"
fi

if [[ -n "${MAS_PROVISION_PROFILE:-}" && -f "${MAS_PROVISION_PROFILE:-}" ]]; then
  cp "$MAS_PROVISION_PROFILE" "$APP/Contents/embedded.provisionprofile"
fi

if [[ -n "${APPLE_MAS_APP_CERT:-}" ]]; then
  echo "==> 5/5 Signing sandboxed child binaries & app bundle, and creating .pkg"
  find "$APP/Contents/Resources/backend" -type f \( -name "*.dylib" -o -name "*.so" -o -perm -u+x \) | while read -r f; do
    case "$f" in */Python.framework/Python) continue ;; esac
    if file "$f" | grep -q "Mach-O"; then
      codesign --force --options runtime --timestamp --entitlements "$CHILD_ENTITLEMENTS" --sign "$APPLE_MAS_APP_CERT" "$f"
    fi
  done
  codesign --force --options runtime --timestamp --entitlements "$MAS_ENTITLEMENTS" --sign "$APPLE_MAS_APP_CERT" "$APP/Contents/MacOS/app"
  codesign --force --options runtime --timestamp --entitlements "$MAS_ENTITLEMENTS" --sign "$APPLE_MAS_APP_CERT" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"

  if [[ -n "${APPLE_MAS_INSTALLER_CERT:-}" ]]; then
    PKG_OUT="$SRC_TAURI/target/release/bundle/macos/AI Usage Ball_${APP_VERSION}_mas.pkg"
    rm -f "$PKG_OUT"
    productbuild --component "$APP" /Applications --sign "$APPLE_MAS_INSTALLER_CERT" "$PKG_OUT"
    echo "Built signed MAS installer: $PKG_OUT"
  else
    echo "APPLE_MAS_INSTALLER_CERT not set; skipping productbuild .pkg step."
  fi
else
  echo "==> 5/5 APPLE_MAS_APP_CERT not set; skipping MAS codesign & productbuild (unsigned .app built at $APP)"
fi
