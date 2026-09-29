# Chrome Web Store submission

Upload `build/prompt-fitness-chrome.zip` (see README, "Chrome Web Store").

## Store listing
- **Name:** Prompt Fitness: AI Footprint
- **Summary (132):** Estimates the water and carbon footprint of your AI chats on your device, with tips for more efficient prompts.
- **Category:** Productivity (Tools)
- **Language:** English
- **Icon:** `extension/icons/icon-128.png`
- **Screenshots:** 1280 × 800, 1 to 5 (popup over a chat, dashboard views)
- **Small promo tile:** 440 × 280

## Privacy practices tab
**Single purpose:**
> Estimate the environmental footprint (water, energy, carbon) of the user's AI chat messages and show prompt-efficiency feedback.

**Permission justifications**
| Permission | Justification |
|---|---|
| `storage` | Saves numeric usage records (time, model id, token counts, score) and settings on the user's device. |
| Content script on chatgpt.com, claude.ai, gemini.google.com | Measures the length of messages on these three AI chat sites to estimate their footprint. No other sites are accessed. |

**Remote code:** No, I am not using remote code. All JavaScript is included in the package.

**Data usage** (check nothing under "collects"): the extension does **not** collect or transmit any of the listed data types.
Certify all three disclosures:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://yourdomain.example/promptfitness/privacy

Note: the extension reads page content (message text) transiently in memory. Chrome's policy treats "website content"
as user data only when it is collected (stored or transmitted). The extension stores numbers only and has
`connect-src 'none'`, so nothing is collected. Keep the privacy policy wording consistent with this.
