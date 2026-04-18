/** Lightweight global "soft delete + undo toast" coordinator.
 *
 *  Replaces the synchronous, modal `window.confirm("Delete X?")` flow
 *  in destructive UI actions with an asynchronous "we did it, here's
 *  ~5 seconds to undo" pattern — same one used by Gmail, Maps, and
 *  basically every modern productivity app. Critical UX upgrade for
 *  touch interfaces where confirm modals are jarring.
 *
 *  Pattern for a callsite:
 *
 *    requestUndoableAction({
 *      label: "Trip deleted",
 *      onConfirm: () => trulyDeleteTrip(id),  // runs after timeout
 *      onUndo:    () => restoreTrip(snapshot), // runs if user taps Undo
 *      timeoutMs: 5000,
 *    });
 *
 *  - The visible UI is owned by `UndoToastHost`, mounted once at the
 *    page root. It subscribes to this module's pubsub and renders the
 *    most recent pending toast.
 *  - At most one toast is visible. Stacking a new request immediately
 *    confirms (commits) the previous one rather than dropping it on
 *    the floor — destructive actions should never silently disappear.
 *  - Page navigation / unload commits any pending action so a closed
 *    tab doesn't strand half-deleted state.
 */

type Listener = (toast: PendingToast | null) => void;

export interface UndoableActionRequest {
  /** Human-readable label, e.g. "Trip deleted" or "Parked pin cleared". */
  label: string;
  /** Optional secondary line, e.g. "It will be removed from your history". */
  detail?: string;
  /** Called once the timeout elapses without an undo tap. Should
   *  perform the actual destructive write. */
  onConfirm: () => void | Promise<void>;
  /** Called when the user taps "Undo" before the timeout elapses. */
  onUndo: () => void | Promise<void>;
  /** How long to wait before committing. Default 5s. */
  timeoutMs?: number;
}

interface PendingToast extends UndoableActionRequest {
  id: string;
  /** Wall-clock ms when the toast appeared, used to render the
   *  countdown bar in `UndoToastHost`. */
  startedAt: number;
}

let current: PendingToast | null = null;
let timer: number | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) {
    try { fn(current); } catch { /* ignore single bad subscriber */ }
  }
}

function commit(): void {
  if (!current) return;
  const t = current;
  current = null;
  if (timer !== null) { window.clearTimeout(timer); timer = null; }
  emit();
  try { Promise.resolve(t.onConfirm()).catch((e) => console.warn("[pp] undo onConfirm failed", e)); }
  catch (e) { console.warn("[pp] undo onConfirm threw", e); }
}

function undo(): void {
  if (!current) return;
  const t = current;
  current = null;
  if (timer !== null) { window.clearTimeout(timer); timer = null; }
  emit();
  try { Promise.resolve(t.onUndo()).catch((e) => console.warn("[pp] undo onUndo failed", e)); }
  catch (e) { console.warn("[pp] undo onUndo threw", e); }
}

/** Initiate a soft-delete with a visible undo toast. Resolves
 *  immediately — the actual action runs after the timeout (or never,
 *  if the user undoes). */
export function requestUndoableAction(req: UndoableActionRequest): void {
  // If there's a pending toast, commit it now so we don't lose the
  // first action when the second arrives quickly.
  if (current) commit();

  const id = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  current = {
    ...req,
    id,
    startedAt: Date.now(),
    timeoutMs: req.timeoutMs ?? 5000,
  };
  emit();

  if (typeof window !== "undefined") {
    timer = window.setTimeout(() => {
      timer = null;
      commit();
    }, current.timeoutMs);
  }
}

export function subscribeUndoToast(fn: Listener): () => void {
  listeners.add(fn);
  // Immediately surface current state so late mounts don't miss
  // an in-flight toast.
  try { fn(current); } catch { /* ignore */ }
  return () => { listeners.delete(fn); };
}

export function getCurrentUndoToast(): PendingToast | null {
  return current;
}

/** Manually trigger the commit/undo paths. Used by `UndoToastHost`
 *  for the buttons; callers shouldn't need these. */
export const __undoInternals = { commit, undo };

// Commit any pending action when the tab is being torn down so we
// don't strand half-deleted state. We use `pagehide` instead of
// `beforeunload` because pagehide fires on bfcache navigations too.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { if (current) commit(); });
}
