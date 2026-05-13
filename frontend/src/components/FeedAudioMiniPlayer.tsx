"use client";

import type { Incident } from "@/lib/api";
import { incidentAudioSources } from "@/lib/public-api-base";
import { Pause, Play, X } from "lucide-react";
import { useEffect, useState } from "react";

type Listener = () => void;

interface FeedAudioState {
  incidentId: string | null;
  label: string;
  playing: boolean;
}

let audio: HTMLAudioElement | null = null;
let state: FeedAudioState = { incidentId: null, label: "", playing: false };
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeFeedAudio(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFeedAudioState(): FeedAudioState {
  return state;
}

export function stopFeedAudio() {
  audio?.pause();
  audio = null;
  state = { incidentId: null, label: "", playing: false };
  emit();
}

export function toggleFeedAudio(inc: Incident, label: string) {
  const sources = incidentAudioSources(inc);
  if (sources.length === 0) return;

  if (state.incidentId === inc.id && audio) {
    if (state.playing) {
      audio.pause();
      state = { ...state, playing: false };
      emit();
    } else {
      void audio.play().then(() => {
        state = { ...state, playing: true };
        emit();
      });
    }
    return;
  }

  audio?.pause();
  const next = new Audio(sources[0]);
  audio = next;
  state = { incidentId: inc.id, label, playing: false };
  next.addEventListener("ended", () => stopFeedAudio());
  next.addEventListener("error", () => stopFeedAudio());
  void next.play().then(() => {
    state = { ...state, playing: true };
    emit();
  });
}

export default function FeedAudioMiniPlayer() {
  const [snap, setSnap] = useState<FeedAudioState>(state);

  useEffect(() => subscribeFeedAudio(() => setSnap({ ...state })), []);

  if (!snap.incidentId) return null;

  return (
    <div
      className="fixed left-3 right-3 z-50 flex items-center gap-2 px-3 py-2 rounded-xl shadow-xl"
      style={{
        bottom: "calc(72px + env(safe-area-inset-bottom, 0px))",
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (!audio) return;
          if (snap.playing) {
            audio.pause();
            state = { ...state, playing: false };
          } else {
            void audio.play().then(() => {
              state = { ...state, playing: true };
              emit();
            });
          }
          setSnap({ ...state });
        }}
        className="w-8 h-8 rounded-full flex items-center justify-center"
        style={{ background: "rgba(59,130,246,0.15)", color: "#60a5fa" }}
        aria-label={snap.playing ? "Pause audio" : "Play audio"}
      >
        {snap.playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>
      <span className="text-xs truncate flex-1" style={{ color: "var(--panel-text)" }}>
        {snap.label}
      </span>
      <button
        type="button"
        onClick={stopFeedAudio}
        className="p-1.5"
        style={{ color: "var(--panel-text-muted)" }}
        aria-label="Close audio player"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
