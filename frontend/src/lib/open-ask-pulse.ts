/** Switch the map shell to the Ask Pulse tab (desktop sidebar + URL sync). */
export function openAskPulseTab(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem("pulse_view_tab", "ask");
  } catch {
    /* private mode */
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "ask");
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("pp:open-ask"));
}
