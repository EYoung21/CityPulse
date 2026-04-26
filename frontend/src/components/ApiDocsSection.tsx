import Link from "next/link";

/**
 * Developer reference for the existing FastAPI JSON endpoints exposed by
 * `philly_pulse/server.py`. Colocated as a server component under
 * `/use-cases/api` so marketing copy and the reference live on the same
 * public URL (no separate `/docs/api` route to keep sitemaps tight).
 *
 * Keep this in sync with real handler signatures — free vs Pro behavior is
 * driven server-side by `_apply_free_since` and the `X-Pulse-Clamped` /
 * `X-Pulse-Free-Window-Sec` headers; do not invent parameters here.
 */

const CODE_BLOCK_STYLE: React.CSSProperties = {
  margin: "0",
  padding: "12px 14px",
  borderRadius: "10px",
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(10,10,20,0.55)",
  color: "rgba(230,230,245,0.92)",
  fontFamily:
    "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: "12.5px",
  lineHeight: 1.55,
  overflowX: "auto",
  whiteSpace: "pre",
};

const INLINE_CODE_STYLE: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: "5px",
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.05)",
  fontFamily:
    "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: "12.5px",
  color: "rgba(235,235,250,0.92)",
};

const H2_STYLE: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: "1.05rem",
  fontWeight: 600,
  letterSpacing: "0.02em",
  color: "rgba(255,255,255,0.92)",
};

const H3_STYLE: React.CSSProperties = {
  margin: "16px 0 6px",
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "rgba(255,255,255,0.88)",
};

const ENDPOINT_ROW_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  padding: "4px 10px",
  borderRadius: "6px",
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.04)",
  fontFamily:
    "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: "12.5px",
  marginBottom: "8px",
};

const METHOD_BADGE_STYLE: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: "4px",
  fontSize: "10.5px",
  fontWeight: 700,
  letterSpacing: "0.04em",
};

function Method({ verb }: { verb: "GET" | "POST" }) {
  const bg = verb === "GET" ? "rgba(59,130,246,0.2)" : "rgba(139,92,246,0.22)";
  const color = verb === "GET" ? "#93c5fd" : "#c4b5fd";
  return (
    <span style={{ ...METHOD_BADGE_STYLE, background: bg, color }}>{verb}</span>
  );
}

function Endpoint({ verb, path }: { verb: "GET" | "POST"; path: string }) {
  return (
    <div style={ENDPOINT_ROW_STYLE}>
      <Method verb={verb} />
      <span>{path}</span>
    </div>
  );
}

function SubNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="lp-usecases-sub"
      style={{ margin: "0 0 10px", textAlign: "left", maxWidth: 720, fontSize: "0.95rem" }}
    >
      {children}
    </p>
  );
}

export default function ApiDocsSection() {
  return (
    <section
      aria-labelledby="api-developer-reference"
      style={{
        marginTop: "28px",
        paddingTop: "24px",
        borderTop: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <p className="lp-stat-label" style={{ marginBottom: 6 }}>
        Developer reference
      </p>
      <h2
        id="api-developer-reference"
        className="lp-usecases-title"
        style={{ margin: "0 0 14px", fontSize: "clamp(1.25rem, 3vw, 1.75rem)", lineHeight: 1.2 }}
      >
        HTTP JSON API
      </h2>
      <SubNote>
        CityPulse is a FastAPI service with public read endpoints and an optional
        Firebase <code style={INLINE_CODE_STYLE}>Authorization: Bearer</code> header
        that unlocks deeper history for Pro users. Same endpoints the web app calls.
      </SubNote>

      {/* ── Base URL ─────────────────────────────────────────── */}
      <h3 style={H3_STYLE}>Base URL</h3>
      <SubNote>
        Direct origin: <code style={INLINE_CODE_STYLE}>https://api.phlpulse.com</code>
        . Same-origin proxy (from any CityPulse deployment):{" "}
        <code style={INLINE_CODE_STYLE}>https://www.phlpulse.com/api/*</code> — Vercel
        rewrites forward <code style={INLINE_CODE_STYLE}>/api/*</code> to the FastAPI host.
      </SubNote>

      {/* ── Authentication ───────────────────────────────────── */}
      <h3 style={H3_STYLE}>Authentication</h3>
      <SubNote>
        Reads are public. To unlock Pro history, send a Firebase ID token for a
        signed-in Pro account:
      </SubNote>
      <pre style={CODE_BLOCK_STYLE}>
{`curl -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \\
  https://api.phlpulse.com/api/incidents`}
      </pre>
      <SubNote>
        Without a valid Pro token, the server clamps results to the last{" "}
        <strong>1 hour</strong> (<code style={INLINE_CODE_STYLE}>FREE_INCIDENT_WINDOW_SECONDS</code>{" "}
        = 3600). Response headers surface the clamp:
      </SubNote>
      <ul style={{ margin: "0 0 12px 18px", padding: 0, fontSize: "0.92rem", color: "rgba(255,255,255,0.75)" }}>
        <li>
          <code style={INLINE_CODE_STYLE}>X-Pulse-Clamped: 1</code> when the caller asked for more history than the free window allows.
        </li>
        <li>
          <code style={INLINE_CODE_STYLE}>X-Pulse-Free-Window-Sec: 3600</code> on free responses so clients can compute their own effective floor.
        </li>
        <li>
          JSON body <code style={INLINE_CODE_STYLE}>meta.tier</code> is{" "}
          <code style={INLINE_CODE_STYLE}>&quot;pro&quot;</code> or{" "}
          <code style={INLINE_CODE_STYLE}>&quot;free&quot;</code>; also{" "}
          <code style={INLINE_CODE_STYLE}>meta.clamped</code>,{" "}
          <code style={INLINE_CODE_STYLE}>meta.effectiveSince</code>.
        </li>
      </ul>

      {/* ── Endpoints ────────────────────────────────────────── */}
      <h3 style={H3_STYLE}>Endpoints</h3>

      <div style={{ marginTop: 10 }}>
        <Endpoint verb="GET" path="/api/health" />
        <SubNote>
          Liveness + configuration introspection. No auth required.
        </SubNote>
        <pre style={CODE_BLOCK_STYLE}>
{`curl https://api.phlpulse.com/api/health`}
        </pre>
      </div>

      <div style={{ marginTop: 18 }}>
        <Endpoint verb="GET" path="/api/incidents" />
        <SubNote>
          All displayable incidents with the inhibitor / geocode metadata used by
          the map. Query params:
        </SubNote>
        <ul style={{ margin: "0 0 10px 18px", padding: 0, fontSize: "0.92rem", color: "rgba(255,255,255,0.75)" }}>
          <li><code style={INLINE_CODE_STYLE}>since</code> — ISO-8601 lower bound.</li>
          <li><code style={INLINE_CODE_STYLE}>category</code> — severity category filter.</li>
        </ul>
        <pre style={CODE_BLOCK_STYLE}>
{`curl -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \\
  "https://api.phlpulse.com/api/incidents?since=2026-04-24T00:00:00Z"`}
        </pre>
      </div>

      <div style={{ marginTop: 18 }}>
        <Endpoint verb="GET" path="/api/incidents/page" />
        <SubNote>
          Cursor-paginated feed. <code style={INLINE_CODE_STYLE}>limit</code> 1–50
          (default 20). When <code style={INLINE_CODE_STYLE}>near_lat</code> and{" "}
          <code style={INLINE_CODE_STYLE}>near_lng</code> are passed, server sorts
          by distance and returns <code style={INLINE_CODE_STYLE}>mode: &quot;near&quot;</code>.
        </SubNote>
        <ul style={{ margin: "0 0 10px 18px", padding: 0, fontSize: "0.92rem", color: "rgba(255,255,255,0.75)" }}>
          <li><code style={INLINE_CODE_STYLE}>cursor</code>, <code style={INLINE_CODE_STYLE}>limit</code>, <code style={INLINE_CODE_STYLE}>since</code>, <code style={INLINE_CODE_STYLE}>category</code>, <code style={INLINE_CODE_STYLE}>city</code></li>
          <li><code style={INLINE_CODE_STYLE}>near_lat</code>, <code style={INLINE_CODE_STYLE}>near_lng</code> — proximity mode.</li>
        </ul>
        <pre style={CODE_BLOCK_STYLE}>
{`curl "https://api.phlpulse.com/api/incidents/page?limit=20&city=philly"`}
        </pre>
      </div>

      <div style={{ marginTop: 18 }}>
        <Endpoint verb="GET" path="/api/incidents/search" />
        <SubNote>
          Free-text search. <code style={INLINE_CODE_STYLE}>q</code> is required;
          terms are ANDed across title, category, description, and location.
          Honors the caller&apos;s <code style={INLINE_CODE_STYLE}>since</code>/
          <code style={INLINE_CODE_STYLE}>until</code> window.
        </SubNote>
        <pre style={CODE_BLOCK_STYLE}>
{`curl -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \\
  "https://api.phlpulse.com/api/incidents/search?q=shots%20fired&limit=50"`}
        </pre>
      </div>

      <div style={{ marginTop: 18 }}>
        <Endpoint verb="GET" path="/api/summary" />
        <SubNote>
          2–3 sentence LLM summary of recent activity. Body includes{" "}
          <code style={INLINE_CODE_STYLE}>summary</code>,{" "}
          <code style={INLINE_CODE_STYLE}>incident_count</code>, and the usual{" "}
          <code style={INLINE_CODE_STYLE}>meta</code> object.
        </SubNote>
      </div>

      <div style={{ marginTop: 18 }}>
        <Endpoint verb="GET" path="/api/stats" />
        <SubNote>
          Aggregate counters for the transparency strip:{" "}
          <code style={INLINE_CODE_STYLE}>total_incidents</code> and{" "}
          <code style={INLINE_CODE_STYLE}>inhibitor_stats</code> (per-status counts).
        </SubNote>
      </div>

      {/* ── Fair use + legal ─────────────────────────────────── */}
      <h3 style={H3_STYLE}>Rate limits &amp; fair use</h3>
      <SubNote>
        The API is in <strong>limited pilot</strong>. There is no self-serve
        org-grade API key yet — tokens are scoped to the signed-in user. If you
        plan to call this from a backend job, contact us first so we can agree on
        volume and latency expectations. Abuse will be rate-limited or blocked.
      </SubNote>

      <h3 style={H3_STYLE}>Data quality &amp; legal</h3>
      <SubNote>
        Responses reflect scanner audio and automated extraction—treat as unverified
        intelligence, not a dispatch feed or emergency system. Commercial / high-stakes use may
        require a legal review of jurisdiction-specific scanner retransmission
        rules and the terms of the underlying audio provider (for example,{" "}
        <a
          href="https://www.broadcastify.com/terms/"
          target="_blank"
          rel="noreferrer"
          style={{ color: "rgb(var(--accent-rgb))", textDecoration: "underline", textUnderlineOffset: 3 }}
        >
          Broadcastify terms
        </a>
        ). Do not surface victim PII downstream without your own redaction review.
      </SubNote>

      {/* ── Next steps ───────────────────────────────────────── */}
      <h3 style={H3_STYLE}>Next steps</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: 4 }}>
        <Link href="/login" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
          Sign in for Pro
        </Link>
        <Link href="/" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
          Open the live map
        </Link>
        <Link href="/teams" className="lp-hero-cta" style={{ display: "inline-block", marginTop: 0 }}>
          Teams hub
        </Link>
      </div>
    </section>
  );
}
