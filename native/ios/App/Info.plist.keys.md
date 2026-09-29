# App/Info.plist keys

`scripts/setup-ios.sh` sets these with PlistBuddy. Listed here for review.

| Key | Value | Why |
|---|---|---|
| `CFBundleDisplayName` | `Prompt Fitness` | Home-screen name (max ~12 visible characters) |
| `ITSAppUsesNonExemptEncryption` | `false` | No custom encryption; skips the export-compliance prompt |
| `UIUserInterfaceStyle` | `Dark` | The dashboard is dark-only; keeps system UI (keyboard, sheets) consistent |
| `UIRequiresFullScreen` | not set | Supports iPad multitasking |

Do **not** add any `NS…UsageDescription` keys. The app uses no camera, photos,
location, contacts, microphone or tracking, and App Review flags unused permission strings.
