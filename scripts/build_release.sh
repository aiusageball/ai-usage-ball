#!/bin/bash
# Full release build for AI Usage Ball: PyInstaller onedir sidecar -> Tauri
# build -> manual notarization workaround -> DMG.
#
# WHY this isn't just `npm run tauri build` + Tauri's own auto-notarize:
# Tauri's `bundle.resources` copy step unconditionally DEREFERENCES the
# Python.framework/Python symlink (PyInstaller's onedir output ships it as
# `Foo.framework/Foo -> Versions/Current/Foo`, the standard macOS framework
# bundle convention). Apple's notarization service enforces that convention
# strictly and rejects a dereferenced duplicate file there even if it has an
# otherwise byte-valid embedded signature ("The signature of the binary is
# invalid"). So: build WITHOUT Apple env vars (skips Tauri's own auto-notarize),
# fix the symlink in the built .app, re-sign, notarize manually, staple, then
# hand-build the DMG from the fixed .app (Tauri's own DMG would package the
# still-broken pre-fix .app).
#
# Also: Tauri's `resources` mapping does NOT auto-sign nested executables/
# dylibs the way `externalBin` sidecars do, so every Mach-O file under the
# bundled backend resource folder needs an explicit codesign pass too.
#
# Also produces the auto-updater artifacts: `AI Usage Ball.app.tar.gz` +
# `.sig` (signed with the updater keypair, separate from the Developer ID
# cert) and a `latest.json` manifest. tauri.conf.json's plugins.updater
# endpoint points at
# https://github.com/aiusageball/ai-usage-ball/releases/latest/download/latest.json
# — so every release upload MUST include latest.json and the .app.tar.gz
# alongside the .dmg, or existing installs will never see the new version.
#
# Usage: scripts/build_release.sh
# Requires: APPLE_ID, APPLE_TEAM_ID env vars set; Developer ID cert in
# Keychain; notary password stored via `xcrun notarytool store-credentials`
# OR in Keychain under service "Notary" (see NOTARY_PW below); updater
# signing key at ~/Library/Application Support/AIPulse/aiusageball_updater.key
# with its password in Keychain under service "AIUsageBall-UpdaterKey".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD="$REPO_ROOT/dashboard"
SRC_TAURI="$DASHBOARD/src-tauri"
IDENTITY="Developer ID Application: BIN XU (46C3XZQNFT)"
ENTITLEMENTS="$SRC_TAURI/entitlements.plist"
APPLE_ID="${APPLE_ID:-xbyxy@msn.com}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-46C3XZQNFT}"
NOTARY_PW="$(security find-generic-password -s 'Notary' -w)"
export TAURI_SIGNING_PRIVATE_KEY="$HOME/Library/Application Support/AIPulse/aiusageball_updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s 'AIUsageBall-UpdaterKey' -w)"
APP_VERSION="$(node -p "require('$SRC_TAURI/tauri.conf.json').version")"

echo "==> 1/6 Rebuilding the PyInstaller onedir backend sidecar"
SERVER_DIR="$REPO_ROOT/server"
DIST_DIR="$HOME/Library/Application Support/AIPulse/dist"
(
  cd "$SERVER_DIR"
  rm -rf "$DIST_DIR/aipulse-server" "$DIST_DIR/build"
  pyinstaller --onedir --name aipulse-server \
    --distpath "$DIST_DIR" --workpath "$DIST_DIR/build" \
    --collect-all uvicorn --collect-all fastapi --collect-all zeroconf \
    --collect-all browser_cookie3 --collect-all anyio \
    --add-data "$DASHBOARD/public/liquid-loop.mp4:." --noconfirm \
    server.py
)

echo "==> 2/6 Copying sidecar into src-tauri/resources (dereferencing symlinks)"
RESOURCES="$SRC_TAURI/resources/aipulse-server"
rm -rf "$RESOURCES"
mkdir -p "$SRC_TAURI/resources"
cp -RL "$DIST_DIR/aipulse-server" "$RESOURCES"

echo "==> 3/6 Signing all 135+ nested Mach-O binaries (Tauri resources are not auto-signed)"
find "$RESOURCES" -type f \( -name "*.dylib" -o -name "*.so" -o -perm -u+x \) | while read -r f; do
  if file "$f" | grep -q "Mach-O"; then
    codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$f"
  fi
done

echo "==> 4/6 tauri build WITHOUT Apple env vars (signs, skips auto-notarize)"
(
  cd "$DASHBOARD"
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  npm run tauri build
)

APP="$SRC_TAURI/target/release/bundle/macos/AI Usage Ball.app"

echo "==> 5/6 Fixing the Python.framework symlink Tauri dereferenced, then re-signing + notarizing"
PYFW="$APP/Contents/Resources/backend/_internal/Python.framework/Python"
rm -f "$PYFW"
ln -s "Versions/Current/Python" "$PYFW"
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP/Contents/MacOS/app"
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

ZIP=/tmp/AI-Usage-Ball-manual.zip
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$NOTARY_PW" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl -a -vvv "$APP"

echo "==> 6/6 Hand-building the DMG from the fixed+notarized .app"
STAGING=/tmp/dmg_staging
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
DMG_DIR="$SRC_TAURI/target/release/bundle/dmg"
mkdir -p "$DMG_DIR"
DMG="$DMG_DIR/AI Usage Ball_0.1.0_aarch64.dmg"
rm -f "$DMG"
hdiutil create -volname "AI Usage Ball" -srcfolder "$STAGING" -ov -format UDZO "$DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

echo "==> Generating latest.json (updater manifest)"
TARBALL="$SRC_TAURI/target/release/bundle/macos/AI Usage Ball.app.tar.gz"
SIGNATURE="$(cat "$TARBALL.sig")"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
LATEST_JSON="$SRC_TAURI/target/release/bundle/latest.json"
cat > "$LATEST_JSON" <<EOF
{
  "version": "$APP_VERSION",
  "notes": "See https://github.com/aiusageball/ai-usage-ball/releases/tag/v$APP_VERSION",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIGNATURE",
      "url": "https://github.com/aiusageball/ai-usage-ball/releases/download/v$APP_VERSION/AI.Usage.Ball.app.tar.gz"
    }
  }
}
EOF

echo "Done."
echo "  DMG:         $DMG"
echo "  Updater tgz: $TARBALL"
echo "  Manifest:    $LATEST_JSON"
echo ""
echo "To ship the update, upload ALL THREE to the GitHub release (renaming the tarball to match the URL above, spaces -> dots):"
echo "  gh release upload v$APP_VERSION \"$DMG\" \"$TARBALL#AI.Usage.Ball.app.tar.gz\" \"$LATEST_JSON\" --clobber"
