/** Web Speech API helper with feature detection. Chrome / Edge / Safari (iOS
 *  14.5+) expose either `SpeechRecognition` or vendor-prefixed
 *  `webkitSpeechRecognition`. Firefox does not. */

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface VoiceOptions {
  onResult: (transcript: string, isFinal: boolean) => void;
  onError?: (msg: string) => void;
  onEnd?: () => void;
  lang?: string;
}

export function isVoiceSearchSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Returns a controller you can `.stop()` early. Auto-stops on first final
 *  result so the caller can wire it directly to a search submit. */
export function startVoiceSearch(opts: VoiceOptions): { stop: () => void } | null {
  if (!isVoiceSearchSupported()) return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition)!;
  const rec = new Ctor();
  rec.lang = opts.lang || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    const transcript = last?.[0]?.transcript ?? "";
    const isFinal = !!(last as unknown as { isFinal?: boolean }).isFinal;
    opts.onResult(transcript, isFinal);
    if (isFinal) {
      try { rec.stop(); } catch { /* ignore */ }
    }
  };
  rec.onerror = (e) => opts.onError?.(e.error || "voice-error");
  rec.onend = () => opts.onEnd?.();

  try {
    rec.start();
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : "voice-start-failed");
    return null;
  }
  return { stop: () => { try { rec.abort(); } catch { /* ignore */ } } };
}
