const CITYPULSE_TIPS = [
  "Tap a place to see a safe route around reported incidents.",
  "Long-press the map to avoid an area or peek at live activity nearby.",
  "The colored map clusters show severity at a glance.",
  "Turn on Avoid traffic to prefer the route that keeps moving.",
  "Use the five avoidance toggles to choose which incident types routes should avoid.",
  "Fresh public crash reports can reroute you before congestion sensors catch up.",
  "Tap a district to see recent safety context for that area.",
  "Search an address, then pick the Safer route before you go.",
];

export function getRandomCityPulseTip(): string {
  return CITYPULSE_TIPS[Math.floor(Math.random() * CITYPULSE_TIPS.length)];
}

export { CITYPULSE_TIPS };
