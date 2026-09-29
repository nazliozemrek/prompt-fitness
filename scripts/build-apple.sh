#!/usr/bin/env bash
# Builds the Safari flavor of the extension and runs Apple's converter.
#  - macOS: a standalone container app + extension (Capacitor has no macOS target).
#  - iOS:   a reference project only; the real iOS extension lives inside the Capacitor app
#           (see README). Use the reference to compare against Xcode's template.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname)" == "Darwin" ]] || { echo "✗ Run this on macOS with Xcode installed."; exit 1; }

BUNDLE_ID="${BUNDLE_ID:-com.promptfitness.app}"
APP_NAME="${APP_NAME:-Prompt Fitness}"

npm run build:ext
npm run check:privacy

# macOS container app + Safari extension
xcrun safari-web-extension-converter build/extension-safari \
  --project-location safari-mac \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open --no-prompt --force

# iOS reference project (not shipped)
xcrun safari-web-extension-converter build/extension-safari \
  --project-location build/safari-ios-reference \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --swift \
  --ios-only \
  --copy-resources \
  --no-open --no-prompt --force

# Keep the iOS extension inside the Capacitor app in sync, if it has been created.
if [[ -d ios/App/Extension ]]; then
  mkdir -p ios/App/Extension/Resources
  rsync -a --delete build/extension-safari/ ios/App/Extension/Resources/
  echo "✓ Synced resources into ios/App/Extension/Resources"
fi

echo
echo "✓ macOS project: safari-mac/  (set your Team, then Product > Archive)"
echo "  Review converter warnings above: any unsupported manifest key is a release blocker."
