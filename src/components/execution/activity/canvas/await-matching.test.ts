import { describe, expect, it } from "vitest";
import { awaitForSurface, awaitToFollow } from "./await-matching";
import type { PendingCanvasAwait } from "./await-matching";

const named = (requestId: string, surfaceId: string): PendingCanvasAwait => ({
  requestId,
  surfaceId,
});
const any = (requestId: string): PendingCanvasAwait => ({ requestId, surfaceId: null });

describe("awaitForSurface", () => {
  it("is null when nothing is pending, so the surface renders inert", () => {
    expect(awaitForSurface([], "dash")).toBeNull();
    expect(awaitForSurface([named("r1", "other")], "dash")).toBeNull();
  });

  it("matches a wait that names the surface", () => {
    expect(awaitForSurface([named("r1", "dash")], "dash")?.requestId).toBe("r1");
  });

  it("keeps two named waits independent", () => {
    const pending = [named("r1", "form-a"), named("r2", "form-b")];
    expect(awaitForSurface(pending, "form-a")?.requestId).toBe("r1");
    expect(awaitForSurface(pending, "form-b")?.requestId).toBe("r2");
  });

  it("lets a wait with no surfaceId be answered from any canvas", () => {
    const pending = [any("r1")];
    expect(awaitForSurface(pending, "dash")?.requestId).toBe("r1");
    expect(awaitForSurface(pending, "form")?.requestId).toBe("r1");
  });

  it("prefers the wait that named the surface over a catch-all", () => {
    // The agent asked about `form` specifically; answering its other, vaguer question with this
    // click would strand the one it is actually blocked on.
    const pending = [any("catch-all"), named("specific", "form")];
    expect(awaitForSurface(pending, "form")?.requestId).toBe("specific");
    expect(awaitForSurface(pending, "dash")?.requestId).toBe("catch-all");
  });

  it("takes the newest of several waits on the same surface", () => {
    const pending = [named("old", "form"), named("new", "form")];
    expect(awaitForSurface(pending, "form")?.requestId).toBe("new");
  });

  it("is null for a surface that does not exist yet", () => {
    expect(awaitForSurface([any("r1")], null)).toBeNull();
    expect(awaitForSurface([any("r1")], undefined)).toBeNull();
  });
});

describe("awaitToFollow", () => {
  it("pages to the newest wait that names a surface", () => {
    expect(awaitToFollow([named("r1", "a"), named("r2", "b")])?.surfaceId).toBe("b");
  });

  it("stays put for a catch-all wait, which the current canvas can already answer", () => {
    expect(awaitToFollow([any("r1")])).toBeNull();
    expect(awaitToFollow([])).toBeNull();
  });

  it("ignores a catch-all that arrived after a named wait", () => {
    expect(awaitToFollow([named("r1", "a"), any("r2")])?.requestId).toBe("r1");
  });
});
