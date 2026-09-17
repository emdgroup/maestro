import { describe, it, expect } from "vitest";
import { activityReducer } from "../useAcpActivity";
import { INITIAL_ACTIVITY_STATE } from "../types";
import { surfaceFromHtml, surfaceToHtml } from "./canvas-file";

function makeEvent(payload: Record<string, unknown>) {
  return {
    type: "event" as const,
    payload: payload as never,
    raw: payload,
  };
}

function created(extra: Record<string, unknown> = {}) {
  return activityReducer(
    INITIAL_ACTIVITY_STATE,
    makeEvent({
      sessionUpdate: "canvas_create",
      surfaceId: "s1",
      title: "My Dashboard",
      html: "<div id='root'>hello</div>",
      ...extra,
    }),
  );
}

describe("canvas reducer", () => {
  it("canvas_create adds the surface to canvasMap and a canvas item to the stream", () => {
    const state = created();

    expect(state.canvasMap.size).toBe(1);
    const surface = state.canvasMap.get("s1");
    expect(surface?.title).toBe("My Dashboard");
    expect(surface?.html).toBe("<div id='root'>hello</div>");
    // The default is the theme that makes a surface look like the rest of the app.
    expect(surface?.theme).toBe("maestro");
    expect(surface?.sources).toEqual([]);
    expect(surface?.data).toEqual({});

    const canvasItems = state.items.filter((i) => i.type === "canvas");
    expect(canvasItems).toHaveLength(1);
    expect((canvasItems[0] as { type: "canvas"; item: { surfaceId: string } }).item.surfaceId).toBe(
      "s1",
    );
  });

  it("keeps the theme and sources the agent declared", () => {
    const state = created({ theme: "none", sources: ["https://api.example.com"] });
    expect(state.canvasMap.get("s1")?.theme).toBe("none");
    expect(state.canvasMap.get("s1")?.sources).toEqual(["https://api.example.com"]);
  });

  it("canvas_update without a target replaces the document", () => {
    let state = created();
    state = activityReducer(
      state,
      makeEvent({ sessionUpdate: "canvas_update", surfaceId: "s1", html: "<p id='p'>new</p>" }),
    );

    const surface = state.canvasMap.get("s1")!;
    expect(surface.html).toBe("<p id='p'>new</p>");
    expect(surface.patch).toBeUndefined();
  });

  it("canvas_update with a target is forwarded to the frame, not merged into the document", () => {
    let state = created();
    state = activityReducer(
      state,
      makeEvent({
        sessionUpdate: "canvas_update",
        surfaceId: "s1",
        target: "root",
        html: "<div id='root'>patched</div>",
      }),
    );

    const surface = state.canvasMap.get("s1")!;
    // The authored document is what a reload shows, which is the same trade the surface already
    // makes with anything the user typed into it.
    expect(surface.html).toBe("<div id='root'>hello</div>");
    expect(surface.patch).toEqual({ seq: 1, target: "root", html: "<div id='root'>patched</div>" });

    // A second patch has to differ from the first, or the frame would never be told about it.
    state = activityReducer(
      state,
      makeEvent({
        sessionUpdate: "canvas_update",
        surfaceId: "s1",
        target: "root",
        html: "<div id='root'>patched</div>",
      }),
    );
    expect(state.canvasMap.get("s1")!.patch?.seq).toBe(2);
  });

  it("canvas_data stores data at path", () => {
    let state = created();
    state = activityReducer(
      state,
      makeEvent({
        sessionUpdate: "canvas_data",
        surfaceId: "s1",
        path: "/rows",
        value: [
          ["a", "b"],
          ["c", "d"],
        ],
      }),
    );

    expect(state.canvasMap.get("s1")!.data["/rows"]).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("canvas_update on unknown surfaceId is a no-op", () => {
    const state = activityReducer(
      INITIAL_ACTIVITY_STATE,
      makeEvent({ sessionUpdate: "canvas_update", surfaceId: "nope", html: "<p></p>" }),
    );
    expect(state.canvasMap.size).toBe(0);
  });
});

describe("saved canvas files", () => {
  const surface = {
    surfaceId: "s1",
    title: 'Latency & "load"',
    html: "<div id='root'>hello</div>",
    theme: "tailwind" as const,
    sources: ["https://api.example.com"],
    data: { "/rows": [1, 2, 3] },
    createdAt: 1758000000000,
  };

  it("round trips through a self-contained .html file", () => {
    const restored = surfaceFromHtml(surfaceToHtml(surface));
    expect(restored).toEqual(surface);
  });

  it("gives the agent's document back byte for byte", () => {
    // What makes the file worth opening in a browser: Maestro's own head is never written to it,
    // and nothing is rewritten on the way back in.
    const file = surfaceToHtml(surface);
    expect(file).toContain("<div id='root'>hello</div>");
    expect(file).not.toContain("tailwindcss");
    expect(surfaceFromHtml(file)!.html).toBe(surface.html);
  });

  it("survives a data bag holding a closing script tag", () => {
    const risky = { ...surface, data: { "/snippet": "</script><b>x" } };
    expect(surfaceFromHtml(surfaceToHtml(risky))!.data).toEqual(risky.data);
  });

  it("is null for a file it did not write", () => {
    expect(surfaceFromHtml("<html><body>not ours</body></html>")).toBeNull();
  });
});
