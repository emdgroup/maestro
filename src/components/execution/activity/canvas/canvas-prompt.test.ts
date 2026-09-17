import { describe, it, expect } from "vitest";
import {
  buildCanvasEventPrompt,
  buildCanvasRestoredPrompt,
  parseCanvasPrompt,
} from "./canvas-prompt";

describe("canvas prompts", () => {
  it("carries everything the tool result would have carried", () => {
    const text = buildCanvasEventPrompt({
      surfaceId: "match",
      componentId: "chatForm",
      kind: "submit",
      value: "send",
      values: { message: "hi", persona: "Rust" },
    });

    expect(text).toContain("`match`");
    expect(text).toContain("`chatForm`");
    expect(text).toContain("kind: submit");
    expect(text).toContain('"message":"hi"');
    // The agent is only in a turn because of this prompt, so it has to be told to re-arm.
    expect(text).toContain("canvas_await");
  });

  it("leaves out what the event did not carry", () => {
    const text = buildCanvasEventPrompt({
      surfaceId: "dash",
      componentId: "refresh",
      kind: "click",
      values: {},
    });

    expect(text).not.toContain("- value:");
    expect(text).not.toContain("- fields:");
  });

  it("names every restored surface once", () => {
    const text = buildCanvasRestoredPrompt(["match", "stats"]);
    expect(text).toContain("2 canvas surfaces");
    expect(text).toContain("`match`, `stats`");
  });

  it("round-trips through the wrapper the stream reads", () => {
    const event = parseCanvasPrompt(
      buildCanvasEventPrompt({
        surfaceId: "match",
        componentId: "chatForm",
        kind: "submit",
        values: {},
      }),
    );
    expect(event).toEqual({
      kind: "event",
      surfaceId: "match",
      componentId: "chatForm",
      eventKind: "submit",
    });

    expect(parseCanvasPrompt(buildCanvasRestoredPrompt(["a", "b"]))).toEqual({
      kind: "restored",
      surfaces: ["a", "b"],
    });
  });

  it("does not claim a message the user typed", () => {
    expect(parseCanvasPrompt("fix the canvas-event handler please")).toBeNull();
    expect(parseCanvasPrompt("<canvas-event>no attributes</canvas-event>")).toBeNull();
    // Only at the start: a quoted example inside a real message stays a real message.
    expect(parseCanvasPrompt('see this: <canvas-event surface="x" kind="click">')).toBeNull();
  });
});
