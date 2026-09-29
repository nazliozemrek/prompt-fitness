#!/usr/bin/env bash
# Prepares the Capacitor iOS project: native plugin, App Group, privacy manifest, Info.plist,
# and (once the target exists) the Safari Web Extension. Idempotent. macOS + Xcode only.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname)" == "Darwin" ]] || { echo "✗ Run this on macOS with Xcode installed."; exit 1; }

[[ -d ios/App ]] || npx cap add ios
npm run build
npm run check:privacy
npx cap sync ios

APP=ios/App/App
cp native/ios/App/MainViewController.swift native/ios/App/SharedLogPlugin.swift \
   native/ios/App/App.entitlements native/ios/App/PrivacyInfo.xcprivacy "$APP/"
cp native/ios/Shared/SharedStore.swift "$APP/"

# Use MainViewController (registers the SharedLog plugin) instead of the stock bridge controller.
STORYBOARD="$APP/Base.lproj/Main.storyboard"
if grep -q 'customClass="CAPBridgeViewController"' "$STORYBOARD"; then
  sed -i '' 's/customClass="CAPBridgeViewController" customModule="Capacitor"/customClass="MainViewController" customModule="App" customModuleProvider="target"/' "$STORYBOARD"
  echo "✓ Main.storyboard now uses MainViewController"
fi

PLIST="$APP/Info.plist"
plutil -replace CFBundleDisplayName -string "Prompt Fitness" "$PLIST"
plutil -replace ITSAppUsesNonExemptEncryption -bool NO "$PLIST"
plutil -replace UIUserInterfaceStyle -string "Dark" "$PLIST"
echo "✓ Info.plist keys set"

EXT=ios/App/Extension
if [[ -d "$EXT" ]]; then
  cp native/ios/Extension/SafariWebExtensionHandler.swift native/ios/Extension/Info.plist \
     native/ios/Extension/Extension.entitlements native/ios/Extension/PrivacyInfo.xcprivacy "$EXT/"
  mkdir -p "$EXT/Resources"
  rsync -a --delete build/extension-safari/ "$EXT/Resources/"
  echo "✓ Safari extension resources synced into $EXT/Resources"
fi

if ! ruby -e "require 'xcodeproj'" 2>/dev/null; then
  echo "Installing the xcodeproj gem (user scope)…"
  gem install --user-install xcodeproj
fi
ruby native/ios/add-to-xcode.rb ios/App/App.xcodeproj

echo
echo "Next: open ios/App/App.xcworkspace, set your Team on both targets, and confirm the App Group"
echo "      group.com.promptfitness.app is enabled under Signing & Capabilities."
