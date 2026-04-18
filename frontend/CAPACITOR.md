# Capacitor wrap (iOS / Android)

The web build is the source of truth. Capacitor wraps it as a native shell.

## One-time setup

```bash
cd frontend

# 1. Add platforms (creates ./ios and ./android folders, gitignored)
npx cap add ios
npx cap add android
```

## Run modes

`capacitor.config.ts` defaults to **static export** mode (`webDir: "out"`).
Pick one of the two flows below:

### Option A — Static export (offline-capable bundle)

Requires a fully static Next.js build. Add to `next.config.ts`:

```ts
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
};
```

Then build + sync:

```bash
npm run build           # produces ./out
npx cap sync
npx cap open ios        # or `npx cap open android`
```

Caveats:
- `/api/*` edge routes (e.g. `/api/og`, `/api/route-directions`) are **not**
  bundled — they must remain hosted. Set `NEXT_PUBLIC_API_URL` to the public
  origin so the client hits them.
- `/share/page.tsx` (server component) is also **not** bundled. The deep-link
  flow still works because users open share links in the browser, which then
  bounces them back into the installed app via the universal link.

### Option B — Live wrap (instant updates, requires internet)

Uncomment the `server.url` block in `capacitor.config.ts` pointing at your
deployed origin:

```ts
server: {
  url: "https://phillypulse.app",
  cleartext: false,
  androidScheme: "https",
},
```

Then sync — no rebuild required for client changes:

```bash
npx cap sync
```

## Native permissions

After `npx cap add ios`, edit `ios/App/App/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>PhillyPulse uses your location to score nearby safety and route around incidents.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>PhillyPulse uses your location to score nearby safety and route around incidents.</string>
```

For Android, edit `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.INTERNET" />
```

## Cross-platform helpers

All native-aware code lives in `src/lib/native.ts`:

- `share(data)` — native sheet on iOS/Android, `navigator.share` on web,
  clipboard fallback.
- `haptic(intensity)` — Capacitor Haptics on native, `navigator.vibrate` on web.
- `getCurrentPosition()` — Capacitor Geolocation on native, browser API on web.
- `configureStatusBar({ style, backgroundColor })` — no-op on web.
- `wireNativeAppEvents({ onBack, onResume })` — Android back button + resume hooks.

`isNative()` and `platform()` let you branch UI when needed.
