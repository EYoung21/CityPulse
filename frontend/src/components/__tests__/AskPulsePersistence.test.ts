import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPulseChatMessages,
  loadAskPulsePersist,
} from "@/components/AskPulsePanel";

beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

describe("Ask Pulse persistence validation", () => {
  it("only sends the bounded conversation tail to the API", () => {
    const messages = Array.from({ length: 45 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message-${index}`,
    }));

    const payload = buildPulseChatMessages(messages);
    expect(payload).toHaveLength(40);
    expect(payload[0]?.content).toBe("message-5");
    expect(payload.at(-1)?.content).toBe("message-44");
  });

  it("drops malformed threads, messages, citations, and tab ids", () => {
    localStorage.setItem("pulse_ask_pulse_v1", JSON.stringify({
      threads: [
        { id: "bad-thread", title: "Bad", updatedAt: Date.now(), messages: {} },
        {
          id: "good-thread",
          title: "Good",
          updatedAt: Date.now(),
          messages: [
            { id: "bad-message", role: "assistant", content: { html: "bad" }, ts: Date.now() },
            {
              id: "good-message",
              role: "assistant",
              content: "Safe text",
              ts: Date.now(),
              cited: [null, { id: "incident", lat: 999, lng: -75 }],
            },
          ],
        },
      ],
      activeId: "missing",
      openTabIds: ["good-thread", "good-thread", "missing", 7],
    }));

    expect(loadAskPulsePersist()).toEqual({
      threads: [expect.objectContaining({
        id: "good-thread",
        messages: [expect.objectContaining({ id: "good-message", content: "Safe text", cited: [
          expect.objectContaining({ id: "incident", lat: null, lng: null }),
        ] })],
      })],
      activeId: null,
      openTabIds: ["good-thread"],
    });
  });
});
