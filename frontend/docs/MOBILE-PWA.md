# Mobile web, PWA install, and native shell (Capacitor)

This app is built as a **responsive Next.js web app** first. Mobile browsers and **installable PWAs** (Chrome “Install app”, iOS “Add to Home Screen”) are the primary distribution path. **Capacitor** is optional for later Play Store / App Store or stricter native APIs.

## PWA behavior (current code)

- **Manifest**: [`public/manifest.json`](../public/manifest.json) — `display: "standalone"`, icons, shortcuts.
- **Service worker**: [`public/sw.js`](../public/sw.js) — registered from [`ServiceWorkerRegister.tsx`](../src/components/ServiceWorkerRegister.tsx) in **production only** (`NODE_ENV === "production"`).
- **Install UI**: [`InstallPrompt.tsx`](../src/components/InstallPrompt.tsx) — Chromium `beforeinstallprompt`, iOS Add to Home Screen instructions, engagement timer, dismiss memory. **Must be mounted** on authenticated routes (see `app/page.tsx`, `app/feed/page.tsx`); feature code calls `requestInstallPrompt()` for high-intent moments (e.g. push settings).
- **Viewport / safe area**: [`app/layout.tsx`](../src/app/layout.tsx) exports `viewport` with `viewportFit: "cover"`; map shell uses `h-dvh` and CSS `env(safe-area-inset-*)` helpers in [`globals.css`](../src/app/globals.css).

### Local verification

1. `cd frontend && npm run build && npm start` (service worker does not register under `next dev` by default).
2. **Android Chrome**: open site over HTTPS (or localhost); confirm install works; open installed icon; pan map and confirm tiles still load.
3. **iOS Safari**: Share → Add to Home Screen; open from home screen; exercise push / notifications flows per product docs.

## When to add or prioritize Capacitor

Use the **Capacitor shell** ([`capacitor.config.ts`](../capacitor.config.ts), [`NativeBoot.tsx`](../src/components/NativeBoot.tsx)) when you need one or more of:

- **App Store / Google Play** discovery, billing, or institutional trust.
- **Background location** or other capabilities that iOS Safari throttles or does not expose to the web.
- Deeper OS integrations (widgets, Siri, CarPlay, etc.) without rewriting the React UI — the same web bundle can ship inside the native wrapper.

Until then, prefer **one responsive codebase** + PWA; avoid maintaining a separate “native-only” product unless requirements force it.
