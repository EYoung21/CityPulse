import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/lib/theme";
import Providers from "@/components/Providers";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const cityName = process.env.NEXT_PUBLIC_CITY_NAME || "Philadelphia";
const siteName = process.env.NEXT_PUBLIC_SITE_NAME || "PHLPulse";
const siteOrigin =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_VERCEL_URL ||
  "http://localhost:3000";
const metadataBaseUrl = (() => {
  try {
    const u = siteOrigin.startsWith("http") ? siteOrigin : `https://${siteOrigin}`;
    return new URL(u);
  } catch {
    return new URL("http://localhost:3000");
  }
})();

export const metadata: Metadata = {
  metadataBase: metadataBaseUrl,
  title: `CityPulse — ${siteName} · ${cityName}`,
  description:
    `CityPulse: Real-time AI-powered community safety for ${cityName}. Live police scanner transcription, incident mapping, and safe routing.`,
  manifest: "/manifest.json",
  applicationName: "PhillyPulse",
  appleWebApp: {
    capable: true,
    title: "PhillyPulse",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  formatDetection: { telephone: false },
  openGraph: {
    title: `CityPulse — ${siteName} · ${cityName}`,
    description: `Real-time AI-powered community safety map for ${cityName}.`,
    type: "website",
    siteName: "PhillyPulse",
    images: [{ url: "/api/og", width: 1200, height: 630, alt: "PhillyPulse — live safety map" }],
  },
  twitter: {
    card: "summary_large_image",
    title: `CityPulse — ${siteName} · ${cityName}`,
    description: `Real-time AI-powered community safety map for ${cityName}.`,
    images: ["/api/og"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a14" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          crossOrigin=""
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers><ThemeProvider>{children}</ThemeProvider></Providers>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
