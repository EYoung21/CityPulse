"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform, useInView } from "framer-motion";
import {
  PULSE_CITIES,
  heroIncidentBounds,
  getCurrentCity,
  type PulseCity,
} from "@/lib/pulse-cities";
import { CityMapCanvas } from "./CityMapCanvas";
import { CitySkylineSvg } from "./CitySkylineSvg";
import { CitySwitcher } from "./CitySwitcher";
import { AnimatedNumber } from "./AnimatedNumber";
import { SafeRouteSection } from "./SafeRouteSection";
import { NewsroomSection } from "./NewsroomSection";
import { SecuritySection } from "./SecuritySection";
import { ResearchSection } from "./ResearchSection";
import { ApiSection } from "./ApiSection";
import { navigateToCity } from "@/lib/pulse-navigate";
import { useCityStats } from "@/hooks/useCityStats";
import "./landing.css";

type LandingCity = PulseCity & {
  brand: string;
  tagline: string;
  accentRgb: string;
  accentRgb2: string;
  population: string;
  areaSqMi: number;
  neighborhoods: string[];
  scannerFeeds: number;
  routeDemoPairs: NonNullable<PulseCity["routeDemoPairs"]>;
  heroIncidents: NonNullable<PulseCity["heroIncidents"]>;
};

function toLandingCity(city: PulseCity): LandingCity {
  return {
    ...city,
    brand: city.brand ?? `${city.name}Pulse`,
    tagline: city.tagline ?? `Real-time safety intelligence for ${city.name}.`,
    accentRgb: city.accentRgb ?? "171, 255, 2",
    accentRgb2: city.accentRgb2 ?? "224, 255, 160",
    population: city.population ?? "N/A",
    areaSqMi: city.areaSqMi ?? 0,
    neighborhoods: city.neighborhoods ?? [],
    scannerFeeds: city.scannerFeeds ?? 0,
    routeDemoPairs: city.routeDemoPairs ?? [],
    heroIncidents: city.heroIncidents ?? [],
  };
}

/* ═══════════════════════════════════════════════════
   ScrollSceneCanvas — scroll-driven wireframe city
   Uses the current city's accent color, generic 3D skyline.
   ═══════════════════════════════════════════════════ */
function ScrollSceneCanvas({
  className,
  city,
}: { className: string; city: LandingCity }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef(0);

  useEffect(() => {
    const cvs = ref.current!;
    const ctx = cvs.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    let w = 0, h = 0, raf = 0;

    function resize() {
      w = cvs.parentElement!.clientWidth;
      h = cvs.parentElement!.clientHeight;
      cvs.width = w * dpr; cvs.height = h * dpr;
      cvs.style.width = `${w}px`; cvs.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    addEventListener("resize", resize);

    function onScroll() {
      const parent = cvs.closest(".lp-scroll-scene") as HTMLElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const total = parent.offsetHeight - innerHeight;
      scrollRef.current = Math.max(0, Math.min(1, -rect.top / total));
    }
    addEventListener("scroll", onScroll, { passive: true });

    const accent = city.accentRgb;
    const accent2 = city.accentRgb2;

    const buildings: { x: number; w: number; h: number }[] = [];
    for (let i = 0; i < 80; i++) {
      buildings.push({
        x: Math.random(),
        w: Math.random() * 0.025 + 0.008,
        h: Math.random() * 0.35 + 0.05,
      });
    }
    buildings.sort((a, b) => a.x - b.x);

    function frame(t: number) {
      ctx.clearRect(0, 0, w, h);
      const progress = scrollRef.current;

      const gridAlpha = Math.max(0.15, 1 - progress * 2.5);
      const cityAlpha = Math.max(0.1, Math.min(1, (progress - 0.05) * 1.5));
      const dataAlpha = Math.min(1, Math.max(0, (progress - 0.4) * 2));

      if (gridAlpha > 0.01) {
        const centerX = w / 2;
        const centerY = h * 0.7;
        const gridSize = 40;
        const rows = 30;
        const cols = 40;
        const rotX = -0.6 + progress * 0.3;

        ctx.strokeStyle = `rgba(${accent},${gridAlpha * 0.15})`;
        ctx.lineWidth = 1;

        for (let row = 0; row < rows; row++) {
          ctx.beginPath();
          const z = row / rows;
          const scale = 0.3 + z * 0.7;
          const y = centerY + (row - rows / 2) * gridSize * scale * Math.cos(rotX);
          for (let col = 0; col < cols; col++) {
            const x = centerX + (col - cols / 2) * gridSize * scale;
            if (col === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        for (let col = 0; col < cols; col++) {
          ctx.beginPath();
          for (let row = 0; row < rows; row++) {
            const z = row / rows;
            const scale = 0.3 + z * 0.7;
            const x = centerX + (col - cols / 2) * gridSize * scale;
            const y = centerY + (row - rows / 2) * gridSize * scale * Math.cos(rotX);
            if (row === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      if (cityAlpha > 0.01) {
        const horizon = h * (0.65 - progress * 0.1);
        ctx.strokeStyle = `rgba(${accent},${cityAlpha * 0.4})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, horizon); ctx.lineTo(w, horizon); ctx.stroke();

        buildings.forEach((b, i) => {
          const depth = b.x;
          const scale = 0.6 + depth * 0.4;
          const bx = b.x * w;
          const bw = b.w * w * scale;
          const bh = b.h * h * (0.5 + progress * 0.5) * scale;
          const by = horizon - bh;
          const isoOffsetX = (b.x - 0.5) * 30;
          const isoOffsetY = depth * -20;
          const phase = Math.sin(t * 0.001 + i * 0.7);

          ctx.save();
          ctx.translate(isoOffsetX, isoOffsetY);

          ctx.fillStyle = `rgba(${accent},${cityAlpha * 0.1})`;
          ctx.fillRect(bx, by, bw, bh);

          ctx.fillStyle = `rgba(${accent},${cityAlpha * 0.15})`;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + bw * 0.3, by - bw * 0.3);
          ctx.lineTo(bx + bw + bw * 0.3, by - bw * 0.3);
          ctx.lineTo(bx + bw, by);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = `rgba(${accent},${cityAlpha * 0.08})`;
          ctx.beginPath();
          ctx.moveTo(bx + bw, by);
          ctx.lineTo(bx + bw + bw * 0.3, by - bw * 0.3);
          ctx.lineTo(bx + bw + bw * 0.3, by + bh - bw * 0.3);
          ctx.lineTo(bx + bw, by + bh);
          ctx.closePath();
          ctx.fill();

          ctx.strokeStyle = `rgba(${accent},${cityAlpha * (0.35 + phase * 0.1)})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);

          const floors = Math.floor(bh / 12);
          for (let f = 1; f < floors; f++) {
            const fy = by + (bh / floors) * f;
            ctx.globalAlpha = cityAlpha * 0.15;
            ctx.beginPath(); ctx.moveTo(bx, fy); ctx.lineTo(bx + bw, fy); ctx.stroke();
          }
          ctx.globalAlpha = 1;

          if (dataAlpha > 0.1) {
            for (let f = 1; f < floors; f++) {
              if (Math.sin(i * 13 + f * 7) > 0.3) continue;
              const fy = by + (bh / floors) * f + 3;
              const fx = bx + bw * 0.3;
              ctx.fillStyle = `rgba(${accent2},${dataAlpha * 0.6})`;
              ctx.fillRect(fx, fy, bw * 0.15, 3);
              if (bw > 12) {
                ctx.fillRect(fx + bw * 0.3, fy, bw * 0.15, 3);
              }
            }
          }

          ctx.fillStyle = `rgba(6, 6, 17, ${(1 - depth) * 0.3})`;
          ctx.fillRect(bx, by, bw, bh);
          ctx.restore();
        });

        if (dataAlpha > 0.05) {
          const numArcs = 5;
          for (let i = 0; i < numArcs; i++) {
            const sx = w * (0.15 + i * 0.17);
            const ex = sx + w * 0.15;
            const sy = horizon - h * 0.2;
            const ey = horizon - h * 0.1;
            const cp = (t * 0.001 + i * 1.3) % (Math.PI * 2);

            ctx.strokeStyle = `rgba(${accent2},${dataAlpha * 0.4})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.quadraticCurveTo((sx + ex) / 2, sy - 60 + Math.sin(cp) * 20, ex, ey);
            ctx.stroke();

            const arcP = (t * 0.0003 + i * 0.2) % 1;
            const arcQ = 1 - arcP;
            const dotX = arcQ * arcQ * sx + 2 * arcQ * arcP * ((sx + ex) / 2) + arcP * arcP * ex;
            const dotY = arcQ * arcQ * sy + 2 * arcQ * arcP * (sy - 60 + Math.sin(cp) * 20) + arcP * arcP * ey;
            ctx.fillStyle = `rgba(${accent2},${dataAlpha * 0.8})`;
            ctx.beginPath(); ctx.arc(dotX, dotY, 2.5, 0, 6.283); ctx.fill();
          }

          const scanX = (t * 0.08) % w;
          ctx.strokeStyle = `rgba(${accent2},${dataAlpha * 0.2})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(scanX, 0); ctx.lineTo(scanX, h); ctx.stroke();
        }

        for (let i = 0; i < 30; i++) {
          const px = (Math.sin(t * 0.0003 + i * 4.1) * 0.5 + 0.5) * w;
          const py = (Math.cos(t * 0.0004 + i * 3.7) * 0.5 + 0.5) * h;
          ctx.fillStyle = `rgba(${accent},${cityAlpha * 0.2})`;
          ctx.beginPath(); ctx.arc(px, py, 1, 0, 6.283); ctx.fill();
        }
      }

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      removeEventListener("resize", resize);
      removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [city]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

/* ═══════════════════════════════════════════════════
   Word — scroll-driven opacity
   ═══════════════════════════════════════════════════ */
function Word({ children, progress, range }: {
  children: string; progress: ReturnType<typeof useScroll>["scrollYProgress"]; range: [number, number];
}) {
  const opacity = useTransform(progress, range, [0.1, 1]);
  return <motion.span className="lp-word" style={{ opacity }}>{children}</motion.span>;
}

/* ═══════════════════════════════════════════════════
   Sister CityCard — links out to another city's domain
   ═══════════════════════════════════════════════════ */
function SisterCityCard({ city, i }: { city: LandingCity; i: number }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <motion.a
      ref={ref}
      href={`https://${city.domain}`}
      className="lp-city-card"
      style={
        {
          "--card-accent": `rgb(${city.accentRgb})`,
          "--card-accent-rgb": city.accentRgb,
        } as React.CSSProperties
      }
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay: i * 0.07, ease: [0.25, 0.46, 0.45, 0.94] }}
      onClick={(e) => {
        e.preventDefault();
        void navigateToCity(city);
      }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
        e.currentTarget.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
      }}
    >
      <div className="lp-card-skyline-wrap">
        <CitySkylineSvg
          city={city}
          variant="card"
          accentRgbVar="var(--card-accent-rgb)"
        />
      </div>
      <div className="lp-card-top">
        <div className="lp-card-emoji">{city.emoji}</div>
        <div>
          <div className="lp-card-name">{city.name}</div>
          <div className="lp-card-domain">{city.domain}</div>
        </div>
        <div className="lp-card-pulse">
          <div className="lp-pulse-dot" />
          <div className="lp-pulse-ring" />
        </div>
      </div>
      <div className="lp-card-meta">
        <span>{city.population} residents</span>
        <span>·</span>
        <span>{city.scannerFeeds} feeds</span>
      </div>
      <div className="lp-card-go">
        <span>Visit {city.brand}</span>
        <span>↗</span>
      </div>
    </motion.a>
  );
}

/* ═══════════════════════════════════════════════════
   StatsStrip — city-specific real numbers
   Blends live data from /api/city-stats/:slug (polled every
   30s) with static metadata baked into PULSE_CITIES, and
   tweens between values so the counters actually tick up.
   ═══════════════════════════════════════════════════ */
type StatCell =
  | { kind: "numeric"; label: string; value: number; live?: boolean }
  | { kind: "string"; label: string; value: string; live?: boolean };

function StatsStrip({ city }: { city: LandingCity }) {
  const { stats: live } = useCityStats(city.slug, { refreshMs: 30_000 });

  // Prefer live numbers when available (>= 0); otherwise fall back to
  // the hardcoded defaults from PULSE_CITIES. The backend returns -1
  // when data is unavailable (e.g. SQLite dev store).
  const scannerFeeds =
    live && live.scannerFeeds >= 0 ? live.scannerFeeds : city.scannerFeeds;
  const incidents24h = live && live.incidents24h >= 0 ? live.incidents24h : null;

  const cells: StatCell[] = [
    {
      kind: "numeric",
      label: "Scanner feeds",
      value: scannerFeeds,
      live: !!(live && live.scannerFeeds >= 0),
    },
  ];
  if (incidents24h !== null) {
    cells.push({
      kind: "numeric",
      label: "Incidents, last 24h",
      value: incidents24h,
      live: true,
    });
  } else {
    cells.push({ kind: "string", label: "Population", value: city.population });
  }
  cells.push({ kind: "numeric", label: "Square miles", value: city.areaSqMi });
  cells.push({
    kind: "numeric",
    label: "Neighborhoods",
    value: city.neighborhoods.length,
  });

  return (
    <div className="lp-stats-strip">
      {cells.map((s) => (
        <div key={s.label} className="lp-stat-cell">
          {s.live && <div className="lp-stat-live" aria-label="Live data" />}
          <div className="lp-stat-value">
            {s.kind === "numeric" ? (
              <AnimatedNumber value={s.value} durationMs={900} />
            ) : (
              s.value
            )}
          </div>
          <div className="lp-stat-key">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   NeighborhoodMarquee — scrolling list of covered hoods
   ═══════════════════════════════════════════════════ */
function NeighborhoodMarquee({ city }: { city: LandingCity }) {
  const doubled = [...city.neighborhoods, ...city.neighborhoods];
  return (
    <div className="lp-marquee">
      <div className="lp-marquee-track">
        {doubled.map((n, i) => (
          <span key={`${n}-${i}`} className="lp-marquee-item">
            <span className="lp-marquee-dot" />
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Landing Page
   ═══════════════════════════════════════════════════ */
export default function LandingPage() {
  // Hydration-safe city resolution: start with SSR-known (env slug or Philly default),
  // then re-resolve client-side in case we're on a production domain without env.
  const [city, setCity] = useState<LandingCity>(() => toLandingCity(getCurrentCity()));
  useEffect(() => {
    const c = toLandingCity(getCurrentCity());
    if (c.slug !== city.slug) setCity(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollTextRef = useRef(null);
  const { scrollYProgress: scrollP } = useScroll({
    target: scrollTextRef,
    offset: ["start 0.95", "start 0.1"],
  });

  const statRef = useRef(null);
  const { scrollYProgress: statP } = useScroll({
    target: statRef,
    offset: ["start 0.85", "start 0.2"],
  });

  const headlineWords =
    `We listen to every police scanner in ${city.name}. That\u2019s how we know which routes to avoid.`.split(" ");

  const liveCities = PULSE_CITIES.filter((c) => !c.previewOnly);
  const liveCount = liveCities.length;
  const statWords =
    `Real-time safety intelligence across ${liveCount} live metropolitan areas today.`.split(" ");

  const sisterCities = liveCities
    .filter((c) => c.slug !== city.slug)
    .map(toLandingCity);

  return (
    <div
      className="landing-page"
      style={
        {
          "--accent": `rgb(${city.accentRgb})`,
          "--accent-rgb": city.accentRgb,
          "--accent2": `rgb(${city.accentRgb2})`,
          "--accent2-rgb": city.accentRgb2,
        } as React.CSSProperties
      }
    >
      {/* ═══ Header ═══ */}
      <header className="lp-header">
        <a href="/" className="lp-header-brand" aria-label="CityPulse home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="lp-header-logo" />
          <span className="lp-header-wordmark">CityPulse</span>
        </a>
        <CitySwitcher current={city} />
        <div className="lp-header-actions">
          <a href="/login" className="lp-header-cta">
            Create Account / Sign In
          </a>
        </div>
      </header>

      {/* ═══ Hero — real dark map + city skyline ribbon ═══ */}
      <section className="lp-hero">
        <div className="lp-hero-bg">
          <CityMapCanvas
            className="lp-hero-map"
            city={city}
            pitch={0}
            bearing={0}
            bounds={heroIncidentBounds(city)}
            boundsPadding={56}
            incidents={city.heroIncidents}
          />
          <div className="lp-skyline-ribbon">
            <CitySkylineSvg city={city} variant="hero" />
          </div>
        </div>
        <div className="lp-hero-content">
          <motion.div
            className="lp-hero-channel"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            role="status"
            aria-label={`Live scanner feed for ${city.name}`}
          >
            <span className="lp-hero-channel__pulse" aria-hidden="true" />
            <div className="lp-hero-channel__body">
              <p className="lp-hero-channel__line">Open channel · {city.name}</p>
              <p className="lp-hero-channel__domain">{city.domain}</p>
            </div>
          </motion.div>
          <motion.h1
            className="lp-hero-title"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          >
            {city.brand}
          </motion.h1>
          <motion.p
            className="lp-hero-sub lp-hero-sub--vs"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="lp-hero-sub-pulse">
              What&rsquo;s actually happening in {city.name}, live.
            </span>
            <span className="lp-hero-sub-gmaps">
              For logistics, newsrooms, event security, research, developers
              &mdash; and anyone who just wants to know.
            </span>
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            <a href="/login" className="lp-hero-cta">
              Create Account / Sign In
            </a>
          </motion.div>
          <motion.div
            className="lp-hero-personas"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.7, ease: [0.22, 1, 0.36, 1] }}
            aria-label="Jump to a use case"
          >
            <a href="#logistics" className="lp-hero-persona-pill">
              <span className="lp-hero-persona-icon" aria-hidden="true">⟶</span>
              <span>Logistics</span>
            </a>
            <a href="#newsroom" className="lp-hero-persona-pill">
              <span className="lp-hero-persona-icon" aria-hidden="true">◉</span>
              <span>Newsroom</span>
              <span className="lp-hero-persona-pro">Pro</span>
            </a>
            <a href="#security" className="lp-hero-persona-pill">
              <span className="lp-hero-persona-icon" aria-hidden="true">▣</span>
              <span>Security</span>
            </a>
            <a href="#research" className="lp-hero-persona-pill">
              <span className="lp-hero-persona-icon" aria-hidden="true">▤</span>
              <span>Research</span>
            </a>
            <a href="#api" className="lp-hero-persona-pill">
              <span className="lp-hero-persona-icon" aria-hidden="true">{"</>"}</span>
              <span>API</span>
              <span className="lp-hero-persona-pro">Pro</span>
            </a>
          </motion.div>
        </div>
        <div className="lp-scroll-cue">
          <div className="lp-scroll-arrow" />
          <span>Scroll to explore</span>
        </div>
      </section>

      {/* ═══ Persona deep-dives — co-equal, anchored from hero pills ═══ */}
      <SafeRouteSection city={city} />
      <NewsroomSection city={city} />
      <SecuritySection city={city} />
      <ResearchSection city={city} />
      <ApiSection city={city} />

      {/* ═══ Neighborhood marquee — "we cover ..." ═══ */}
      <NeighborhoodMarquee city={city} />

      {/* ═══ Stats strip — real numbers for this city ═══ */}
      <section className="lp-stats-section">
        <div className="lp-stats-header">
          <div className="lp-stat-label">{city.name} · Coverage</div>
        </div>
        <StatsStrip city={city} />
      </section>

      {/* ═══ Cross-links + disclaimer (replaces the old use-cases grid;
              the persona deep-dives above cover each card in depth) ═══ */}
      <section className="lp-usecases" aria-label="Disclaimer and cross-links">
        <div className="lp-usecases-inner">
          <div className="lp-usecases-foot" style={{ flexDirection: "column", gap: "14px" }}>
            <span className="lp-usecases-note">
              Data is scanner-derived and not verified as fact&mdash;see <strong>About</strong> on the map for the full disclaimer. Without signing in, incident reads are about the <strong>last hour</strong>; <strong>Pro</strong> adds the <strong>Analytics tab</strong> (hotspots, categories, timing), <strong>Ask Pulse</strong> (LLM Q&amp;A with grounded counts), deeper history, <strong>keyword push alerts</strong>, and <strong>programmatic access</strong>.{" "}
              <Link
                href="/teams"
                className="lp-usecases-teams-link"
                style={{ color: "rgb(var(--accent-rgb))", textDecoration: "underline", textUnderlineOffset: 3 }}
              >
                Teams &amp; app links
              </Link>
              {" · "}
              <Link
                href="/use-cases"
                className="lp-usecases-teams-link"
                style={{ color: "rgb(var(--accent-rgb))", textDecoration: "underline", textUnderlineOffset: 3 }}
              >
                Campaign URLs
              </Link>
            </span>
          </div>
        </div>
      </section>

      {/* ═══ Scroll-Driven Scene ═══ */}
      <section className="lp-scroll-scene">
        <div className="lp-scroll-scene-sticky">
          <ScrollSceneCanvas className="lp-scroll-canvas" city={city} />
          <div className="lp-scroll-text" ref={scrollTextRef}>
            <h2 className="lp-scroll-headline">
              {headlineWords.map((word, i) => (
                <Word key={i} progress={scrollP} range={[i / headlineWords.length, (i + 1) / headlineWords.length]}>
                  {word}
                </Word>
              ))}
            </h2>
          </div>
        </div>
      </section>

      {/* ═══ Statement ═══ */}
      <section className="lp-statement">
        <div className="lp-statement-inner">
          <div className="lp-stat-label">The Pulse Network</div>
          <p className="lp-stat-text" ref={statRef}>
            {statWords.map((word, i) => (
              <Word key={i} progress={statP} range={[i / statWords.length, (i + 1) / statWords.length]}>
                {word}
              </Word>
            ))}
          </p>
          {/* Roster strip — two micro-rows under the scroll-animated
              sentence, so visitors see exactly which cities the
              counts refer to instead of having to scroll all the way
              down to the sister-cities grid. Names are joined by
              middle dots and break naturally on narrow screens. */}
          <div className="lp-roster">
            <div className="lp-roster-row">
              <span className="lp-roster-label">
                <span className="lp-roster-dot lp-roster-dot--live" aria-hidden="true" />
                Live now
              </span>
              <span className="lp-roster-cities">
                {liveCities.map((c) => c.name).join("  ·  ")}
              </span>
            </div>
            <p className="lp-roster-soon" style={{ margin: "0.75rem 0 0", fontSize: "0.95rem", color: "rgba(255,255,255,0.45)" }}>
              More cities soon.
            </p>
          </div>
        </div>
      </section>

      {/* ═══ Sister Cities ═══ */}
      {sisterCities.length > 0 && (
        <section className="lp-cities">
          <div className="lp-cities-header">
            <div className="lp-cities-label">Sister Cities</div>
            <h2 className="lp-cities-title">Other live Pulse cities</h2>
            <p className="lp-cities-sub">
              Pulse is also live in{" "}
              {liveCities
                .filter((c) => c.slug !== city.slug)
                .map((c) => c.name)
                .join(", ")}
              . Open another metro map below.
            </p>
          </div>
          <div className="lp-city-grid">
            {sisterCities.map((c, i) => (
              <SisterCityCard key={c.slug} city={c} i={i} />
            ))}
          </div>
        </section>
      )}

      {/* ═══ CTA ═══ */}
      <footer className="lp-cta">
        <h2 className="lp-cta-title">Listen to {city.name}.</h2>
        <p className="lp-cta-sub">Unverified scanner audio · AI transcription · Open data</p>
        <div className="lp-cta-row">
          <a href="/login" className="lp-hero-cta" style={{ marginTop: 0 }}>
            Create Account / Sign In
          </a>
        </div>
        <div className="lp-cta-row" style={{ marginTop: "2rem" }}>
          {PULSE_CITIES.filter((c) => !c.previewOnly).map((c) => {
            const isCurrent = c.slug === city.slug;
            return (
              <a
                key={c.slug}
                href={isCurrent ? "#" : `https://${c.domain}`}
                className={`lp-cta-pill ${isCurrent ? "current" : ""}`}
                onClick={(e) => {
                  if (isCurrent) {
                    e.preventDefault();
                    return;
                  }
                  e.preventDefault();
                  void navigateToCity(c);
                }}
              >
                <span>{c.emoji}</span>
                <span>{c.brand}</span>
                {isCurrent && <span className="lp-cta-pill-here">·  you are here</span>}
              </a>
            );
          })}
        </div>
        <div className="lp-footer-note">
          © {new Date().getFullYear()} {city.brand} · Real-time scanner transcription
        </div>
      </footer>
    </div>
  );
}
