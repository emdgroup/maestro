import { describe, it, expect, beforeEach } from "vitest";
import { useReviewStore } from "./reviewStore";

describe("reviewStore", () => {
  beforeEach(() => {
    useReviewStore.getState().clearTask(1);
  });

  it("keeps the same state object when the viewed set is unchanged", () => {
    const { setViewedFiles } = useReviewStore.getState();

    setViewedFiles(1, new Set(["a.ts", "b.ts"]));
    const after = useReviewStore.getState();

    // A subscriber watching what it writes would otherwise re-render, re-run its effect, and
    // write again — the loop behind React error #185.
    setViewedFiles(1, new Set(["b.ts", "a.ts"]));
    expect(useReviewStore.getState()).toBe(after);
  });

  it("still records a real change", () => {
    const { setViewedFiles, getViewedFiles } = useReviewStore.getState();

    setViewedFiles(1, new Set(["a.ts"]));
    setViewedFiles(1, new Set(["a.ts", "b.ts"]));
    expect([...getViewedFiles(1)]).toEqual(["a.ts", "b.ts"]);

    setViewedFiles(1, new Set(["b.ts"]));
    expect([...getViewedFiles(1)]).toEqual(["b.ts"]);
  });
});
