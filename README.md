# Prompt Fitness

Estimate the water, energy and carbon footprint of AI prompts, score prompt efficiency, and coach better habits. Everything runs on the device.

One TypeScript codebase ships to five places:

| Target | What it is | Built from |
|---|---|---|
| Web dashboard | Static site, no backend | `web/` + `shared/` → `dist/` |
| iOS / iPadOS app | Capacitor container with the dashboard **and** the Safari Web Extension | `dist/` + `native/ios/` + `build/extension-safari/` |
| macOS app | Converter-generated container for the Safari extension | `build/extension-safari/` → `safari-mac/` |
| Android app | Capacitor app with a "Share to score" target (Android browsers have no extensions) | `dist/` + `native/android/` |
| Chrome extension | MV3 extension (Chrome, Edge, Brave) | `extension/` + `shared/` → `build/extension-chrome/` |

## Repository layout

```
shared/core.ts                 Pure logic: models, footprint formula, prompt analysis, tips, validation
web/                           Dashboard (index.html, app.ts, storage.ts, native.ts, input.css)
extension/
  manifest.json                Base MV3 manifest (merged with manifest.chrome.json / manifest.safari.json)
  src/content.ts               On-page measurement (text → numbers, never stored)
  src/background.ts            Validated storage, badge, Safari → app forwarding
  src/popup.ts, popup.html/css Toolbar popup (Safari iOS shows it as a sheet)
native/ios/                    Swift plugin, App Group store, extension handler, entitlements, privacy manifests
native/android/                Hardened manifest, share-target plugin, backup exclusion rules
scripts/                       build, privacy gate, iOS/Android setup, Safari converter, icon generator
assets/                        Icon and splash sources for @capacitor/assets
store/                         App Store, Play, Chrome Web Store metadata and the privacy policy
tests/                         Unit tests for the core (vitest)
```

`ios/`, `android/` and `safari-mac/` are generated and git-ignored. All customizations live in `native/` and are copied in by the setup scripts, so you can delete and regenerate the platform folders at any time.

## Prerequisites

- Node.js 20 or newer
- macOS with Xcode 16 or newer, CocoaPods (`brew install cocoapods`), and an Apple Developer Program membership for iOS/macOS
- Android Studio (Ladybug or newer) with JDK 21 for Android
- Python 3 with Pillow (`pip install pillow`) only if you regenerate icons

## Quick start

```bash
npm install
npm run release:check     # typecheck + unit tests + build + privacy gate
npx serve dist            # open the dashboard at http://localhost:3000
```

Load the Chrome extension for development: `chrome://extensions` → Developer mode → Load unpacked → `build/extension-chrome`.

## Before your first native build: set your identifiers

Replace the placeholder IDs everywhere (macOS `sed` syntax shown):

```bash
NEW=com.acme.promptfitness
grep -rl 'com.yourcompany.promptfitness' --exclude-dir=node_modules . \
  | xargs sed -i '' "s/com\.yourcompany\.promptfitness/$NEW/g"
# Android Java package folder must match the package name:
mkdir -p native/android/app/src/main/java/com/acme
git mv native/android/app/src/main/java/com/yourcompany/promptfitness native/android/app/src/main/java/com/acme/promptfitness
```

This updates `capacitor.config.json`, the App Group (`group.<id>`) in both entitlements files and `SharedStore.swift`, the Java packages, and the store docs. Also update `PKG_DIR` in `scripts/setup-android.sh`.

## Icons and splash screens

```bash
npm run icons     # regenerate from scripts/generate-icons.py (optional; PNGs are committed)
npm run assets    # @capacitor/assets writes every iOS/Android size into ios/ and android/
```

The App Store icon (`assets/icon-only.png`) has no alpha channel, as Apple requires. The Android adaptive foreground keeps the mark inside the 66% safe zone.

## iOS and iPadOS

### 1. Create and configure the Capacitor project
```bash
npm run ios:setup
```
This adds the iOS platform, builds and syncs the web app, copies the Swift files, switches `Main.storyboard` to `MainViewController` (which registers the `SharedLog` plugin), sets Info.plist keys, and registers files, the privacy manifest and entitlements with the Xcode project.

### 2. Add the Safari extension target (once, in Xcode)
1. `npx cap open ios`
2. File → New → Target → iOS → **Safari Extension**. Product name: **Extension**. Language: Swift. Embed in: **App**. If Xcode offers to activate the scheme, accept.
3. Bundle identifier: `com.yourcompany.promptfitness.Extension`.
4. Close Xcode and run `npm run ios:setup` again. It now copies the handler, Info.plist, entitlements and privacy manifest into `ios/App/Extension`, syncs `build/extension-safari` into `ios/App/Extension/Resources`, and wires everything into the Extension target.
5. Reopen Xcode. Check the Extension target's **Resources** folder: if its icon is a yellow group (not a blue folder), select any files added by the sync that aren't listed yet (for example `icons/`, `popup.css`) and add them to the Extension target once. Delete the template's own sample files (`images/`, `_locales/`) if the template created them.

### 3. Signing and capabilities
For **both** the App and Extension targets:
- Signing & Capabilities → Team: your team.
- **App Groups** → enable `group.com.yourcompany.promptfitness` (create it in the developer portal if Xcode doesn't).
- Deployment target: iOS 16.4 or newer on the Extension target (the manifest's Safari minimum), iOS 15+ for the App.

### 4. Run and archive
- Run on a device, then Settings → Apps → Safari → Extensions → Prompt Fitness → on, and allow the three sites.
- Product → Archive → Distribute → App Store Connect.

Every time the web code changes: `npm run cap:sync` (and `npm run apple:convert` or `npm run ios:setup` to refresh the extension resources).

## macOS

Capacitor has no macOS target, so the Mac app is the converter's container app plus the same extension:

```bash
npm run apple:convert
open safari-mac/*.xcodeproj
```
Set your Team, keep the bundle ID `com.yourcompany.promptfitness` (the same record lets you offer the iOS and Mac apps as a Universal Purchase if you enable it), then Archive. The converter prints warnings for unsupported manifest keys; treat any warning as a release blocker.

The Mac container shows the converter's onboarding screen. If you want the full dashboard on the Mac, the simplest route is to also ship the iPad app on Apple silicon Macs (App Store Connect → Pricing and Availability → "Make this app available" on Mac).

## Android

```bash
npm run android:setup
npx cap open android
```

The setup script installs a manifest that:
- **removes the INTERNET permission** (the app only serves bundled files), which makes the privacy claim verifiable
- disables backup and device-transfer of app data
- registers an `ACTION_SEND` text filter for Share to score

For release builds, enable shrinking in `android/app/build.gradle`:
```gradle
buildTypes {
    release {
        minifyEnabled true
        shrinkResources true
        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
}
```
Check `android/variables.gradle` meets Google Play's current target API requirement, then Build → Generate Signed App Bundle. Verify the permission list of the release build as described in `store/google/data-safety.md`.

## Chrome Web Store

```bash
npm run zip:chrome     # → build/prompt-fitness-chrome.zip
```
Upload the zip and fill the Privacy practices tab from `store/chrome-web-store.md`.

## Privacy verification

`npm run check:privacy` fails the build if:
- any extension bundle contains `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `eval` or an external URL
- a manifest requests anything beyond `storage` (plus `nativeMessaging` on Safari), uses `host_permissions`, or targets sites other than the three chat hosts
- the extension CSP lacks `connect-src 'none'`
- the dashboard loads any external resource, contains inline scripts, or lacks `connect-src 'self'`
- `capacitor.config.json` sets `server.url`, enables CapacitorHttp, or enables web debugging

Beyond the gate, privacy is enforced in code at every boundary: `sanitizeEntry` (TypeScript) and `SharedStore.sanitize` (Swift) reject any record that isn't the exact numeric shape, so text can't be persisted even by a bug upstream.

## How the extension counts

A reply is counted **once**, and only if it was seen growing in the tab (streamed live) and has then been stable for 1.8 seconds with the site's "stop" control gone. Replies that appear complete (history, re-renders, navigating to old chats) are never counted, and messages present in the first 4 seconds after page load are treated as history. Input tokens are the latest prompt plus all earlier messages in the visible conversation, because chat interfaces re-send history with every turn.

The model can't be read reliably from these pages, so each site uses a default (ChatGPT → GPT-4o, Claude → Claude 3.5 Sonnet, Gemini → Gemini 1.5 Pro) that the user can change per site in the popup.

### Maintaining selectors
The three sites change their markup. Selectors live in one place, `ADAPTERS` in `extension/src/content.ts`, each as an ordered fallback list. When a site changes:
1. Open the site, inspect a user message and a reply, and add the new selectors to the front of the list.
2. Check the "stop generating" control's selector in `isStreaming`.
3. Ship an update. Undercounting is the failure mode (nothing is counted), never overcounting.

## Methodology

| Constant | Value | Source / reasoning |
|---|---|---|
| Model water factors | 0.08–0.11 L (light), 0.48–0.52 L (standard), 1.45–1.5 L (heavy) per 10K weighted tokens | UC Riverside, *Making AI Less Thirsty* (Li et al.), which includes off-site water for electricity. Intra-class differences are illustrative. |
| Input weight | 0.2 | Prefill is far cheaper than decode per token; provider price ratios (~1:4 to 1:5) as a proxy |
| Water per kWh | 3.6 L | Li et al.: (0.55 on-site WUE + 1.17 PUE × 3.14 L/kWh grid) / 1.17 |
| Grid carbon | 370 g CO₂e per kWh | Approximate US average, location-based |
| Hidden reasoning | 3 hidden tokens per visible token | Assumption for reasoning models; varies widely |
| Comparison point | 0.26 mL on-site water per median Gemini text prompt | Google, August 2025 (on-site only, so lower) |

All constants are in `shared/core.ts` under `C` and `MODELS`, versioned by `COEFFICIENTS_VERSION`. When you update them, update the "How the numbers work" copy in `web/index.html` and bump the version.

## Release checklist

- [ ] `npm run release:check` passes
- [ ] Bundle IDs and App Group replaced; version bumped in `package.json` (extensions read it at build time) and in Xcode / `android/app/build.gradle`
- [ ] Icons regenerated with `npm run assets`
- [ ] iOS: App and Extension both signed, App Group enabled on both, extension tested on a device on all three sites
- [ ] iOS: Privacy manifests present in both targets (Xcode → Product → Archive → Generate Privacy Report shows no collected data)
- [ ] Android: release build has no INTERNET permission; share target works from another app
- [ ] Chrome: zip uploaded; privacy tab filled from `store/chrome-web-store.md`
- [ ] Privacy policy hosted at a public URL (`store/privacy-policy.html`) and linked in every store
- [ ] Store text uses no third-party trademarks in names, subtitles or keywords

## Known limits

- Footprint numbers are estimates; the app says so in the UI and the store listings.
- Token counts are approximations (about 4 characters per token for English); real tokenizers differ, especially for code and non-Latin scripts.
- Chat-site markup changes can pause automatic counting until selectors are updated.
- Capacitor's native bridge is injected by the native layer, so the dashboard's strict CSP (`script-src 'self'`) is compatible. If you add a plugin that injects inline scripts, test on a device before relaxing the CSP.
