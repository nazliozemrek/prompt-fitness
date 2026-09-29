# App Review notes (paste into "Notes" under App Review Information)

```
Prompt Fitness estimates the water, energy and carbon footprint of AI assistant prompts and coaches users to write more efficient prompts. No account or login is needed.

HOW TO TEST THE APP
1. Open the app. Tap "Try a sample" to load a wordy prompt: the Efficiency Score, footprint and tips update live.
2. Tap "Log prompt" to add it to Today. Only numbers are saved.
3. Tap "Load demo week" (in Recent activity, visible when the log is empty) to populate the 7-day chart. Demo entries are labeled "demo" and can be deleted with "Clear local data".

HOW TO TEST THE IN-APP BROWSER
1. Tap "Connect your AI", then ChatGPT or Claude under "Chat inside Prompt Fitness".
2. Sign in with an email account on the site (Google sign-in isn't available inside apps) and send any message.
3. When the reply finishes, the panel at the bottom shows its estimated water, energy and CO2. Tap Done: the prompt appears in Recent activity with a globe icon.

HOW TO TEST THE SAFARI EXTENSION
1. In the app, tap "Connect your AI" > "Open Safari extension settings" (iOS 26.2+), or go to Settings > Apps > Safari > Extensions > Prompt Fitness > turn on, and allow it for chatgpt.com, claude.ai or gemini.google.com.
2. Open one of those sites in Safari and send any message (a free account on the site is enough). A small "Prompt Fitness is measuring on this device" label appears at the bottom left.
3. When the reply finishes, the label briefly shows the estimate. Tap the extension icon in the address bar to see today's total.
4. Reopen the app: the tracked prompt appears in Recent activity with a puzzle icon.

PRIVACY
Prompt Fitness sends no data anywhere. The in-app browser loads the chosen AI site directly, like Safari, and runs the measuring script in an isolated content world; only numbers reach the app. The extension requests access to three websites only, reads message length on the device, and stores numbers only (never text). Extension-to-app sharing uses an on-device App Group. The figures are clearly labeled as research-based estimates in the app ("How the numbers work").

The app is not affiliated with OpenAI, Anthropic or Google; their sites are named only to describe where the extension works.
```

## Anticipated questions
- **4.2 Minimum functionality:** the app is a full dashboard (scoring, tips, budget, history, charts), not only an extension installer or a wrapper around third-party websites.
- **2.5.1 public APIs:** the Safari settings shortcut uses `SFSafariSettings.openExtensionsSettings` (iOS 26.2+) and falls back to `UIApplication.openSettingsURLString`; no private `App-Prefs:` URLs.
- **5.2.1 / 5.2.2 intellectual property:** no third-party names in the app name, subtitle, keywords or icon.
- **2.5.2 executable code:** all JavaScript is bundled in the binary; `server.url` is not used; no remote code.
- **1.4 / 5.1:** estimates are clearly labeled; nothing is health-related.
