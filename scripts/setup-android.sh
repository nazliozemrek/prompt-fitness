#!/usr/bin/env bash
# Prepares the Capacitor Android project: hardened manifest, share target plugin, backup rules. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -d android/app ]] || npx cap add android
npm run build
npm run check:privacy
npx cap sync android

SRC=native/android/app/src/main
DST=android/app/src/main
PKG_DIR=java/com/yourcompany/promptfitness

cp "$SRC/AndroidManifest.xml" "$DST/AndroidManifest.xml"
mkdir -p "$DST/$PKG_DIR" "$DST/res/xml"
cp "$SRC/$PKG_DIR/MainActivity.java" "$SRC/$PKG_DIR/ShareIntentPlugin.java" "$DST/$PKG_DIR/"
cp "$SRC/res/xml/data_extraction_rules.xml" "$DST/res/xml/"

# Release builds: never debuggable, shrink resources.
GRADLE=android/app/build.gradle
if ! grep -q 'shrinkResources true' "$GRADLE"; then
  echo "… Enable minifyEnabled/shrinkResources for release in $GRADLE (see README, Android release)."
fi

echo "✓ Android project configured. Open with: npx cap open android"
