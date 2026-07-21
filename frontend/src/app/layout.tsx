import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { ThemeProvider } from "@/lib/theme";
import Providers from "@/components/Providers";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import NativeBoot from "@/components/NativeBoot";
import DocumentTitleSync from "@/components/DocumentTitleSync";
import {
  cityPageTitle,
  getCityForRequestHost,
} from "@/lib/pulse-cities";
import { trustedRequestOrigin } from "@/lib/request-origin";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

function metadataBaseFromHost(host: string | null): URL {
  return new URL(trustedRequestOrigin(host));
}

export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get("host");
  const city = getCityForRequestHost(host);
  const title = cityPageTitle(city);
  const description = `CityPulse: Real-time AI-powered community safety for ${city.name}. Live police scanner transcription, incident mapping, and safe routing.`;

  return {
    metadataBase: metadataBaseFromHost(host),
    title,
    description,
    manifest: "/manifest.json",
    applicationName: "CityPulse",
    appleWebApp: {
      capable: true,
      title: "CityPulse",
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
      title,
      description: `Real-time AI-powered community safety map for ${city.name}.`,
      type: "website",
      siteName: "CityPulse",
      images: [{ url: "/api/og", width: 1200, height: 630, alt: "CityPulse · live safety map" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: `Real-time AI-powered community safety map for ${city.name}.`,
      images: ["/api/og"],
    },
  };
}

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
      className={`${geistSans.variable} ${geistMono.variable} dark min-h-dvh antialiased`}
      suppressHydrationWarning
    >
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          crossOrigin=""
        />
      </head>
      <body className="min-h-dvh flex flex-col">
        <Providers><ThemeProvider>{children}</ThemeProvider></Providers>
        <ServiceWorkerRegister />
        <NativeBoot />
        <DocumentTitleSync />
      </body>
    </html>
  );
}
