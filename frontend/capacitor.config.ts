import type { CapacitorConfig } from "@capacitor/cli";

/** PhillyPulse — Capacitor configuration.
 *
 *  Two run modes:
 *
 *   1. STATIC EXPORT (offline-capable bundle):
 *      Add `output: "export"` to next.config.ts and run `next build`. The
 *      pre-rendered files land in `out/` and Capacitor packages them as the
 *      app bundle. Note this disables /api/* edge routes in the bundle —
 *      those must remain hosted (use absolute URLs in the client).
 *
 *   2. LIVE WRAP (deployed app, instant updates):
 *      Uncomment `server.url` below pointing at the deployed origin. The
 *      shell stays native but the JS is fetched from the server.
 *
 *  Bootstrap on a fresh checkout:
 *      cd frontend
 *      npx cap add ios       # or `npx cap add android`
 *      npx cap sync
 *      npx cap open ios
 */
const config: CapacitorConfig = {
  appId: "com.phillypulse.app",
  appName: "CityPulse",
  webDir: "out",

  // server: {
  //   url: "https://phillypulse.app",
  //   cleartext: false,
  //   androidScheme: "https",
  // },

  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: "always",
    limitsNavigationsToAppBoundDomains: true,
  },

  plugins: {
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0a0a14",
    },
    Geolocation: {
      // iOS / Android prompts use Info.plist / AndroidManifest entries —
      // those must be added in the native projects after `npx cap add`.
    },
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: "#0a0a14",
      androidSplashResourceName: "splash",
    },
  },
};

export default config;
