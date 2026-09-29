# Play Console › App content › Data safety

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| Is all of the user data collected by your app encrypted in transit? | Not applicable (no data is collected) |
| Do you provide a way for users to request that their data is deleted? | Not applicable; users can delete all local data in-app ("Clear local data") |

Why "No" is accurate: the release build has **no INTERNET permission** (removed with `tools:node="remove"` in
AndroidManifest.xml), so data physically cannot leave the device. Text received through the share sheet is
analyzed in memory and never stored. On-device storage is not "collection" under Google's definition.

Verify before each release:
```bash
# The permission list must not contain android.permission.INTERNET
aapt2 dump permissions android/app/build/outputs/apk/release/app-release.apk
# or, for the bundle:
bundletool dump manifest --bundle=android/app/build/outputs/bundle/release/app-release.aab | grep -i permission
```

## Other App content declarations
- Ads: **No**
- App access: **All functionality is available without special access**
- Content rating: see content-rating.md
- Target audience: **18+ and 13–17** (not designed for children; avoid "Designed for Families")
- News app: **No**
- Government app: **No**
- Financial features: **None**
- Health: **No**
