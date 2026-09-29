# 🌿 Prompt Fitness

> A privacy-first extension and app that estimates the water, energy and CO₂ footprint of your AI prompts, grades how efficient they are, and helps you build better habits. Everything runs on your device.

![Prompt Fitness](extension/icon.png)

## ✨ Features

- ⚡ **On-page indicator:** a live footprint estimate and prompt-efficiency score (0–100) on ChatGPT, Claude and Gemini.
- 📱 **In-app browser (iOS):** chat with ChatGPT or Claude inside the app and watch each reply's footprint in a live bottom panel. Nothing to install.
- 📊 **Dashboard:** usage trends, average score and tips, on the web, iOS, iPadOS, macOS and Android.
- 🔒 **Privacy-first:** no servers and no network calls. Message text is measured in memory and never stored. Only numbers are kept, in on-device storage.
- 🧹 **Your data, your call:** clear your tracked history at any time from the popup or the dashboard.

## 🚀 Quick start

```bash
git clone https://github.com/nazliozemrek/prompt-fitness.git
cd prompt-fitness
npm install
npm run release:check     # typecheck + unit tests + build + privacy gate
npx serve dist            # open the dashboard at http://localhost:3000
```

Load an extension build for development:

| Browser | Steps |
|---|---|
| Chrome, Edge, Brave | `chrome://extensions` → Developer mode → Load unpacked → `build/extension-chrome` |
| Firefox (121+) | `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `build/extension-firefox/manifest.json` |
| Safari (macOS, iOS) | Build the container app (see [macOS](#macos) or [iOS and iPadOS](#ios-and-ipados)), then enable the extension in Safari settings |

---

One TypeScript codebase ships to six places:

| Target | What it is | Built from |
|---|---|---|
| Web dashboard | Static site, no backend | `web/` + `shared/` → `dist/` |
| iOS / iPadOS app | Capacitor container with the dashboard, an in-app AI browser **and** the Safari Web Extension | `dist/` + `native/ios/` + `build/extension-safari/` |
| macOS app | Converter-generated container for the Safari extension | `build/extension-safari/` → `safari-mac/` |
| Android app | Capacitor app with a "Share to score" target (Android browsers have no extensions) | `dist/` + `native/android/` |
| Chrome extension | MV3 extension (Chrome, Edge, Brave) | `extension/` + `shared/` → `build/extension-chrome/` |
| Firefox add-on | MV3 add-on | `extension/` + `shared/` → `build/extension-firefox/` |

## Repository layout

```
shared/core.ts                 Pure logic: models, footprint formula, prompt analysis, tips, validation
web/                           Dashboard (index.html, app.ts, storage.ts, native.ts, input.css)
extension/
  manifest.json                Base MV3 manifest (merged with manifest.{chrome,firefox,safari}.json)
  src/tracker.ts               Reply counting shared by the extension and the in-app browser (text → numbers)
  src/content.ts               Extension content script: settings, on-page indicator, sends numbers to background
  src/inapp.ts                 In-app browser script (built to dist/inapp.js, injected by the iOS app)
  src/background.ts            Validated storage, badge, Safari → app forwarding
  src/popup.ts, popup.html/css Toolbar popup (Safari iOS shows it as a sheet)
  prototype/                   Earlier vanilla-JS popup with Chart.js (not built or shipped)
native/ios/                    Swift plugins, in-app browser, App Group store, extension handler, entitlements, privacy manifests
native/android/                Hardened manifest, share-target plugin, backup exclusion rules
scripts/                       build, privacy gate, iOS/Android setup, Safari converter, icon generator
assets/                        Icon and splash sources for @capacitor/assets
store/                         App Store, Play, Chrome Web Store metadata and the privacy policy
tests/                         Unit tests for the core (vitest)
```

`ios/`, `android/` and `safari-mac/` are generated and git-ignored. All customizations live in `native/` and are copied in by the setup scripts, so you can delete and regenerate the platform folders at any time.

### Architecture

`shared/core.ts` has no DOM or browser API dependencies. It holds the model table (`MODELS`), the constants (`C`), the footprint formula (`compute`), prompt analysis and tips, and the record validator (`sanitizeEntry`). The extension, the dashboard and the tests all import it, so every target computes the same numbers.

## Prerequisites

- Node.js 20 or newer
- macOS with Xcode 16 or newer, CocoaPods (`brew install cocoapods`), and an Apple Developer Program membership for iOS/macOS
- Android Studio (Ladybug or newer) with JDK 21 for Android
- Python 3 with Pillow (`pip install pillow`) only if you regenerate icons

## Identifiers

The production identifiers are already set throughout the project:

| Identifier | Value |
|---|---|
| App bundle ID / Android package | `com.promptfitness.app` |
| Safari extension bundle ID | `com.promptfitness.app.Extension` |
| App Group | `group.com.promptfitness.app` |
| Firefox add-on ID | `prompt-fitness@nazliozemrek.github.io` |

They appear in `capacitor.config.json`, both entitlements files, `native/ios/Shared/SharedStore.swift`, the Java package under `native/android/.../java/com/promptfitness/app/`, `scripts/setup-android.sh` (`PKG_DIR`), `scripts/build-apple.sh`, `extension/manifest.json` and the store docs. If you change one, change it everywhere; the Android Java folder must match the package name.

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

### In-app AI browser

"Connect your AI" → **Chat inside Prompt Fitness** opens ChatGPT, Claude or Gemini in a native browser screen (`native/ios/App/InAppBrowserViewController.swift`) with a live footprint panel at the bottom. It's the easiest option, since users don't have to install or enable anything.

How it stays private:
- It is a separate `WKWebView`, not the Capacitor web view, so the chat sites can't reach any native plugin.
- `dist/inapp.js` (from `extension/src/inapp.ts`, sharing `tracker.ts` with the extension) is injected at document end in an **isolated `WKContentWorld`**. The page's own scripts can't read it, and only that world can post to the `promptFitness` message handler.
- The handler accepts messages only from the main frame of the three hosts over https. Each entry is re-validated by `SharedStore.sanitize` (numbers only) and appended to the App Group mailbox; the dashboard drains it when the browser closes.
- Top-level navigation stays in the app only for the three sites and their sign-in pages; every other link opens in the system browser. "Clear website data" in the ⋯ menu removes cookies and sign-ins.
- Prompt Fitness adds no requests of its own. The web view talks to the chat site exactly as Safari would.

Limits: Google blocks sign-in inside embedded browsers, so Gemini and "Continue with Google" don't work there; the dashboard points those users to the Safari extension. The browser uses each site's default model (ChatGPT → GPT-4o, Claude → Claude 3.5 Sonnet, Gemini → Gemini 1.5 Pro). Android has no in-app browser, because it would need the INTERNET permission the Android build deliberately removes.

The Safari settings button uses `SFSafariSettings.openExtensionsSettings(forIdentifiers:)` on iOS 26.2+ and falls back to the app's own Settings page with written steps. Private `App-Prefs:` URLs are not used (App Review rejects them).

### 2. Add the Safari extension target (once, in Xcode)
1. `npx cap open ios`
2. File → New → Target → iOS → **Safari Extension**. Product name: **Extension**. Language: Swift. Embed in: **App**. If Xcode offers to activate the scheme, accept.
3. Bundle identifier: `com.promptfitness.app.Extension`.
4. Close Xcode and run `npm run ios:setup` again. It now copies the handler, Info.plist, entitlements and privacy manifest into `ios/App/Extension`, syncs `build/extension-safari` into `ios/App/Extension/Resources`, and wires everything into the Extension target.
5. Reopen Xcode. Check the Extension target's **Resources** folder: if its icon is a yellow group (not a blue folder), select any files added by the sync that aren't listed yet (for example `icons/`, `popup.css`) and add them to the Extension target once. Delete the template's own sample files (`images/`, `_locales/`) if the template created them.

### 3. Signing and capabilities
For **both** the App and Extension targets:
- Signing & Capabilities → Team: your team.
- **App Groups** → enable `group.com.promptfitness.app` (create it in the developer portal if Xcode doesn't).
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
Set your Team, keep the bundle ID `com.promptfitness.app` (the same record lets you offer the iOS and Mac apps as a Universal Purchase if you enable it), then Archive. The converter prints warnings for unsupported manifest keys; treat any warning as a release blocker. (The Firefox `gecko` key in the base manifest is ignored by Safari; if the converter warns about it, move it into `manifest.firefox.json`.)

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

## Firefox Add-ons (AMO)

```bash
npm run zip:firefox    # → build/prompt-fitness-firefox.zip
```
The Firefox build adds `background.scripts` next to `service_worker` (Firefox runs MV3 backgrounds as event pages) and requires Firefox 121 or newer. The add-on ID is set in `browser_specific_settings.gecko.id` in `extension/manifest.json`; keep it unchanged between releases, since AMO uses it to identify the add-on. Upload the zip at addons.mozilla.org → Developer Hub, and reuse the privacy wording from `store/chrome-web-store.md`.

## Privacy verification

`npm run check:privacy` fails the build if:
- any extension bundle (Chrome, Firefox, Safari) or the in-app browser script (`dist/inapp.js`) contains `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `eval` or an external URL
- a manifest requests anything beyond `storage` and `activeTab` (plus `nativeMessaging` on Safari), uses `host_permissions`, or targets sites other than the three chat hosts
- the extension CSP lacks `connect-src 'none'`
- the dashboard loads any external resource (or `inapp.js`), contains inline scripts, or lacks `connect-src 'self'`
- `capacitor.config.json` sets `server.url`, enables CapacitorHttp, or enables web debugging

`activeTab` shows no install warning and grants nothing until the user clicks the toolbar button; the popup uses it only to read the current tab's address for per-site settings.

Beyond the gate, privacy is enforced in code at every boundary: `sanitizeEntry` (TypeScript) and `SharedStore.sanitize` (Swift) reject any record that isn't the exact numeric shape, so text can't be persisted even by a bug upstream.

## How the extension counts

A reply is counted **once**, and only if it was seen growing in the tab (streamed live) and has then been stable for 1.8 seconds with the site's "stop" control gone. Replies that appear complete (history, re-renders, navigating to old chats) are never counted, and messages present in the first 4 seconds after page load are treated as history. Input tokens are the latest prompt plus all earlier messages in the visible conversation, because chat interfaces re-send history with every turn.

The model can't be read reliably from these pages, so each site uses a default (ChatGPT → GPT-4o, Claude → Claude 3.5 Sonnet, Gemini → Gemini 1.5 Pro) that the user can change per site in the popup.

### Maintaining selectors
The three sites change their markup. Selectors live in one place, `ADAPTERS` in `extension/src/tracker.ts` (used by both the extension and the in-app browser), each as an ordered fallback list. When a site changes:
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
- [ ] Version bumped in `package.json` (extensions read it at build time) and in Xcode / `android/app/build.gradle`
- [ ] Icons regenerated with `npm run assets`
- [ ] iOS: in-app browser tested on ChatGPT and Claude (sign in, one reply appears in the bottom panel and in Recent activity after Done)
- [ ] iOS: App and Extension both signed, App Group `group.com.promptfitness.app` enabled on both, extension tested on a device on all three sites
- [ ] iOS: Privacy manifests present in both targets (Xcode → Product → Archive → Generate Privacy Report shows no collected data)
- [ ] Android: release build has no INTERNET permission; share target works from another app
- [ ] Chrome: zip uploaded; privacy tab filled from `store/chrome-web-store.md`
- [ ] Firefox: zip uploaded to AMO; add-on tested on all three sites in Firefox 121+
- [ ] Privacy policy hosted at a public URL (`store/privacy-policy.html`) and linked in every store (replace the `yourdomain.example` placeholders in `store/`)
- [ ] Store text uses no third-party trademarks in names, subtitles or keywords

## Known limits

- Footprint numbers are estimates; the app says so in the UI and the store listings.
- Token counts are approximations (about 4 characters per token for English); real tokenizers differ, especially for code and non-Latin scripts.
- Chat-site markup changes can pause automatic counting until selectors are updated.
- In the iOS in-app browser, Google sign-in is unavailable (Google blocks embedded browsers) and sites may show extra bot checks.
- Capacitor's native bridge is injected by the native layer, so the dashboard's strict CSP (`script-src 'self'`) is compatible. If you add a plugin that injects inline scripts, test on a device before relaxing the CSP.
