import { describe, it, expect } from "vitest";
import { activityReducer } from "../useAcpActivity";
import { INITIAL_ACTIVITY_STATE } from "../types";

function makeEvent(payload: Record<string, unknown>) {
  return {
    type: "event" as const,
    payload: payload as never,
    raw: payload,
  };
}

describe("canvas reducer", () => {
  it("canvas_create adds surface to canvasMap and canvas item to stream", () => {
    const state = activityReducer(
      INITIAL_ACTIVITY_STATE,
      makeEvent({ sessionUpdate: "canvas_create", surfaceId: "s1", catalogId: "maestro-canvas/v1", title: "My Dashboard" }),
    );

    expect(state.canvasMap.size).toBe(1);
    const surface = state.canvasMap.get("s1");
    expect(surface?.title).toBe("My Dashboard");
    expect(surface?.components).toEqual([]);
    expect(surface?.data).toEqual({});

    const canvasItems = state.items.filter((i) => i.type === "canvas");
    expect(canvasItems).toHaveLength(1);
    expect((canvasItems[0] as { type: "canvas"; item: { surfaceId: string } }).item.surfaceId).toBe("s1");
  });

  it("canvas_update merges components by id", () => {
    let state = activityReducer(
      INITIAL_ACTIVITY_STATE,
      makeEvent({ sessionUpdate: "canvas_create", surfaceId: "s1", catalogId: "maestro-canvas/v1", title: "T" }),
    );

    state = activityReducer(
      state,
      makeEvent({
        sessionUpdate: "canvas_update",
        surfaceId: "s1",
        components: [
          { id: "root", component: "Column", children: ["h1"] },
          { id: "h1", component: "Text", text: "Hello", variant: "heading" },
        ],
      }),
    );

    const surface = state.canvasMap.get("s1")!;
    expect(surface.components).toHaveLength(2);
    expect(surface.components.find((c) => c.id === "h1")?.text).toBe("Hello");

    // Update merges — existing id gets replaced
    state = activityReducer(
      state,
      makeEvent({
        sessionUpdate: "canvas_update",
        surfaceId: "s1",
        components: [{ id: "h1", component: "Text", text: "Updated", variant: "heading" }],
      }),
    );

    const updated = state.canvasMap.get("s1")!;
    expect(updated.components).toHaveLength(2); // root still there
    expect(updated.components.find((c) => c.id === "h1")?.text).toBe("Updated");
  });

  it("canvas_data stores data at path", () => {
    let state = activityReducer(
      INITIAL_ACTIVITY_STATE,
      makeEvent({ sessionUpdate: "canvas_create", surfaceId: "s1", catalogId: "maestro-canvas/v1", title: "T" }),
    );

    state = activityReducer(
      state,
      makeEvent({ sessionUpdate: "canvas_data", surfaceId: "s1", path: "/rows", value: [["a", "b"], ["c", "d"]] }),
    );

    const surface = state.canvasMap.get("s1")!;
    expect(surface.data["/rows"]).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("canvas_update on unknown surfaceId is a no-op", () => {
    const state = activityReducer(
      INITIAL_ACTIVITY_STATE,
      makeEvent({ sessionUpdate: "canvas_update", surfaceId: "nope", components: [] }),
    );
    expect(state.canvasMap.size).toBe(0);
  });
});
