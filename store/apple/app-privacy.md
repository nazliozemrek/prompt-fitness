# App Privacy ("nutrition label") answers

**Data collection → "No, we do not collect data from this app."**

Apple defines "collect" as transmitting data off the device in a way that lets you or a partner access it
beyond what's needed to service a request in real time. Prompt Fitness never transmits data. (The in-app browser
loads chatgpt.com, claude.ai and gemini.google.com directly, like Safari; the app adds no requests of its own and
receives nothing from those sites except the numbers below.)

| Data | Where it lives | Leaves the device? |
|---|---|---|
| Usage numbers (time, model id, token counts, score) | App: UserDefaults via @capacitor/preferences. Extension: browser.storage.local | No |
| Numbers passed from the Safari extension to the app | App Group container file on the device | No |
| Numbers from the in-app browser | Passed in memory to the dashboard, then stored with the other usage numbers | No |
| Cookies and sign-ins for the three AI sites (in-app browser) | WebKit's default website data store on the device; "Clear website data" removes them | Only to that site, as in Safari |
| Prompt or reply text | Read transiently in memory to compute numbers, never stored | No |
| Daily budget setting | UserDefaults / browser.storage.local | No |

- Tracking: **No**. No IDFA, no SDKs, no analytics, no crash reporting.
- Privacy manifest: `PrivacyInfo.xcprivacy` in both targets. App declares UserDefaults (reason CA92.1). Collected data types: none. Tracking: false.
- Third-party SDKs: Capacitor core and first-party Capacitor plugins only. None collect data.

If you later add crash reporting or analytics, this answer and the privacy policy MUST change before release.
