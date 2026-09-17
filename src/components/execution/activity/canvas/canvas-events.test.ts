import { describe, it, expect } from "vitest";
import { describeCanvasEvent } from "./canvas-events";

describe("describeCanvasEvent", () => {
  it("carries everything the tool result would have carried", () => {
    const text = describeCanvasEvent({
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
    const text = describeCanvasEvent({
      surfaceId: "dash",
      componentId: "refresh",
      kind: "click",
      values: {},
    });

    expect(text).not.toContain("- value:");
    expect(text).not.toContain("- fields:");
  });
});
