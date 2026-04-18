/**
 * Snap-Map-style screen-space pulse: layered DOM rings/sweep/burst/particles
 * positioned at a pixel point in a container. Self-cleans after ~1.6s.
 *
 * Why DOM (not Leaflet markers): the perspective tilt + conic-gradient sweep
 * conflict with Leaflet's marker transforms; we want pure CSS in the map's
 * own DOM so it sits above the tile layer but below interactive controls.
 */

const PARTICLE_COUNT = 8;
const PARTICLE_BASE_DIST = 80;
const TOTAL_LIFETIME_MS = 1700;

export function spawnSnapPulse(
  container: HTMLElement,
  pageX: number,
  pageY: number,
  opts: { color?: string; glow?: string } = {}
): void {
  if (typeof document === "undefined") return;

  const rect = container.getBoundingClientRect();
  const x = pageX - rect.left;
  const y = pageY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

  const stage = document.createElement("div");
  stage.className = "snap-pulse-stage";
  stage.style.left = `${x}px`;
  stage.style.top = `${y}px`;
  if (opts.color) stage.style.setProperty("--pp-pulse-color", opts.color);
  if (opts.glow) stage.style.setProperty("--pp-pulse-glow", opts.glow);

  // Order matters for layering: burst (under), sweep arm, rings, particles, core
  const burst = document.createElement("div");
  burst.className = "snap-pulse-burst";
  stage.appendChild(burst);

  const sweep = document.createElement("div");
  sweep.className = "snap-pulse-sweep";
  stage.appendChild(sweep);

  for (let i = 1; i <= 3; i++) {
    const ring = document.createElement("div");
    ring.className = `snap-pulse-ring snap-pulse-ring--${i}`;
    stage.appendChild(ring);
  }

  const particles = document.createElement("div");
  particles.className = "snap-pulse-particles";
  particles.style.position = "absolute";
  particles.style.left = "50%";
  particles.style.top = "50%";
  particles.style.width = "0";
  particles.style.height = "0";
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = document.createElement("span");
    const angle = (360 / PARTICLE_COUNT) * i + (Math.random() * 18 - 9);
    const dist = PARTICLE_BASE_DIST + Math.random() * 35;
    const delay = Math.random() * 60;
    p.style.setProperty("--a", `${angle}deg`);
    p.style.setProperty("--d", `${dist}px`);
    p.style.animationDelay = `${delay}ms`;
    particles.appendChild(p);
  }
  stage.appendChild(particles);

  const core = document.createElement("div");
  core.className = "snap-pulse-core";
  stage.appendChild(core);

  container.appendChild(stage);

  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate?.(8);
    } catch {
      /* iOS Safari doesn't support vibrate; silently ignore */
    }
  }

  window.setTimeout(() => {
    stage.remove();
  }, TOTAL_LIFETIME_MS);
}
