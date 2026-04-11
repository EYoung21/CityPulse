const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export interface Incident {
  id: string;
  reported_at: string;
  raw_text: string;
  severity_category: string;
  s_base: number;
  location_text: string | null;
  lat: number | null;
  lng: number | null;
  confidence: number;
  geocode_status: string;
  inhibitor_status: string;
  inhibitor_reason: string | null;
  w_eff: number;
  verification_score: number | null;
  verification_status: string | null;
  verification_summary: string | null;
  verification_checks: string | null;
  verified_at: string | null;
}

export interface VerificationCheck {
  source: string;
  passed: boolean;
  score: number;
  detail: string;
}

export interface VerificationResponse {
  status: string;
  incident_id: string;
  verification: {
    score: number;
    status: string;
    summary: string;
    checks: VerificationCheck[];
  };
  incident: Incident;
}

export interface HealthResponse {
  status: string;
  llm_configured: boolean;
  inhibitor_configured: boolean;
  incident_count: number;
}

export interface StatsResponse {
  total_incidents: number;
  inhibitor_stats: Record<string, number>;
}

export interface SummaryResponse {
  summary: string;
  incident_count: number;
}

export async function fetchIncidents(
  since?: string,
  category?: string
): Promise<Incident[]> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (category) params.set("category", category);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/incidents${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch incidents: ${res.status}`);
  const data = await res.json();
  return data.incidents;
}

export async function fetchSummary(): Promise<SummaryResponse> {
  const res = await fetch(`${API_BASE}/api/summary`);
  if (!res.ok) throw new Error(`Failed to fetch summary: ${res.status}`);
  return res.json();
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  return res.json();
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error(`Failed to fetch health: ${res.status}`);
  return res.json();
}

export async function simulateIncident(): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/simulate`, { method: "POST" });
  if (!res.ok) throw new Error(`Simulate failed: ${res.status}`);
  return res.json();
}

export async function seedDemoData(): Promise<{ status: string; count: number }> {
  const res = await fetch(`${API_BASE}/api/seed`, { method: "POST" });
  if (!res.ok) throw new Error(`Seed failed: ${res.status}`);
  return res.json();
}

export async function verifyIncident(id: string): Promise<VerificationResponse> {
  const res = await fetch(`${API_BASE}/api/verify/${id}`, { method: "POST" });
  if (!res.ok) throw new Error(`Verify failed: ${res.status}`);
  return res.json();
}

export async function verifyAll(): Promise<{ verified_count: number; results: { id: string; score: number; status: string }[] }> {
  const res = await fetch(`${API_BASE}/api/verify-all`, { method: "POST" });
  if (!res.ok) throw new Error(`Verify-all failed: ${res.status}`);
  return res.json();
}
