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
      const current = audio;
      void current.play().then(
        () => {
          if (audio !== current) return;
          state = { ...state, playing: true };
          emit();
        },
        () => {
          if (audio !== current) return;
          state = { ...state, playing: false };
          emit();
        }
      );
    }
    return;
  }

  audio?.pause();
  const next = new Audio(sources[0]);
  audio = next;
  state = { incidentId: inc.id, label, playing: false };
  const stopIfCurrent = () => {
    if (audio === next) stopFeedAudio();
  };
  next.addEventListener("ended", stopIfCurrent);
  next.addEventListener("error", stopIfCurrent);
  void next.play().then(
    () => {
      if (audio !== next) return;
      state = { ...state, playing: true };
      emit();
    },
    () => {
      if (audio !== next) return;
      state = { ...state, playing: false };
      emit();
    }
  );
}

export default function FeedAudioMiniPlayer() {
  const [snap, setSnap] = useState<FeedAudioState>(state);

  useEffect(() => subscribeFeedAudio(() => setSnap({ ...state })), []);

  if (!snap.incidentId) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 pl-2.5 pr-2 py-2 rounded-full shadow-xl backdrop-blur-md w-[calc(100%-1.5rem)] max-w-[420px]"
      style={{
        bottom: "calc(72px + env(safe-area-inset-bottom, 0px))",
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
      }}
      role="status"
    >
      <button
        type="button"
        onClick={() => {
          if (!audio) return;
          if (snap.playing) {
            audio.pause();
            state = { ...state, playing: false };
          } else {
            const current = audio;
            void current.play().then(
              () => {
                if (audio !== current) return;
                state = { ...state, playing: true };
                emit();
              },
              () => {
                if (audio !== current) return;
                state = { ...state, playing: false };
                emit();
              }
            );
          }
          setSnap({ ...state });
        }}
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors"
        style={{
          background: snap.playing ? "#3b82f6" : "rgba(59,130,246,0.15)",
          color: snap.playing ? "#fff" : "#60a5fa",
        }}
        aria-label={snap.playing ? "Pause audio" : "Play audio"}
      >
        {snap.playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>
      <div className="flex-1 min-w-0">
        <div
          className="text-[9px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
          style={{ color: "var(--panel-text-muted)" }}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${snap.playing ? "animate-pulse" : ""}`}
            style={{ background: snap.playing ? "#22c55e" : "var(--panel-text-muted)" }}
          />
          Scanner audio
        </div>
        <span className="block text-xs truncate" style={{ color: "var(--panel-text)" }}>
          {snap.label}
        </span>
      </div>
      <button
        type="button"
        onClick={stopFeedAudio}
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 hover:bg-white/5"
        style={{ color: "var(--panel-text-muted)" }}
        aria-label="Close audio player"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
