import { describe, it, expect } from "vitest";
import {
  buildCanvasConvertPrompt,
  buildCanvasEventPrompt,
  buildCanvasImportedPrompt,
  buildCanvasRestoredPrompt,
  parseCanvasPrompt,
} from "./canvas-prompt";

describe("canvas prompts", () => {
  it("carries everything the tool result would have carried", () => {
    const text = buildCanvasEventPrompt([
      {
        surfaceId: "match",
        componentId: "chatForm",
        kind: "submit",
        value: "send",
        values: { message: "hi", persona: "Rust" },
      },
    ]);

    expect(text).toContain("`match`");
    expect(text).toContain("`chatForm`");
    expect(text).toContain("kind: submit");
    expect(text).toContain('"message":"hi"');
    // The agent is only in a turn because of this prompt, so it has to be told to re-arm.
    expect(text).toContain("canvas_await");
  });

  it("leaves out what the event did not carry", () => {
    const text = buildCanvasEventPrompt([
      { surfaceId: "dash", componentId: "refresh", kind: "click", values: {} },
    ]);

    expect(text).not.toContain("- value:");
    expect(text).not.toContain("- fields:");
  });

  it("numbers a queue and keeps it in order", () => {
    const text = buildCanvasEventPrompt([
      { surfaceId: "ttt", componentId: "board", kind: "click", value: 2, values: {} },
      { surfaceId: "ttt", componentId: "board", kind: "click", value: 8, values: {} },
    ]);

    expect(text).toContain("2 times while you were busy");
    expect(text.indexOf("value: 2")).toBeLessThan(text.indexOf("value: 8"));
    // In the wrapper, which is the part the stream reads.
    expect(text).toContain('count="2"');
  });

  it("names every restored surface once", () => {
    const text = buildCanvasRestoredPrompt(["match", "stats"]);
    expect(text).toContain("2 canvas surfaces");
    expect(text).toContain("`match`, `stats`");
  });

  it("round-trips through the wrapper the stream reads", () => {
    const event = parseCanvasPrompt(
      buildCanvasEventPrompt([
        { surfaceId: "match", componentId: "chatForm", kind: "submit", values: {} },
      ]),
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

  it("tells an imported surface apart from one the agent drew", () => {
    const text = buildCanvasImportedPrompt("dash", "/srv/wt/.maestro/imports/dash.html");

    // The path is the whole point: the agent has no copy of a document it did not write, so it
    // cannot name a single element id without reading the file.
    expect(text).toContain("/srv/wt/.maestro/imports/dash.html");
    expect(text).toContain("canvas_await");
    expect(parseCanvasPrompt(text)).toEqual({ kind: "imported", surfaces: ["dash"] });
  });

  it("asks for a conversion rather than announcing a surface", () => {
    const text = buildCanvasConvertPrompt("/srv/wt/.maestro/imports/report.html");

    expect(text).toContain("canvas_create");
    expect(parseCanvasPrompt(text)).toEqual({
      kind: "convert",
      path: "/srv/wt/.maestro/imports/report.html",
    });
  });

  it("does not claim a message the user typed", () => {
    expect(parseCanvasPrompt("fix the canvas-event handler please")).toBeNull();
    expect(parseCanvasPrompt("<canvas-event>no attributes</canvas-event>")).toBeNull();
    // Only at the start: a quoted example inside a real message stays a real message.
    expect(parseCanvasPrompt('see this: <canvas-event surface="x" kind="click">')).toBeNull();
  });
});
