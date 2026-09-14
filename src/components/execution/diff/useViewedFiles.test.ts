import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useViewedFiles } from "./useViewedFiles";
import type { DisplayItem } from "@/types/review";

const diff = (fileName: string, hunks: string[]): DisplayItem => ({
  kind: "diff",
  file: { fileName, hunks },
});

describe("useViewedFiles", () => {
  it("drops the mark when the file's diff changes", () => {
    const { result, rerender } = renderHook(({ items }) => useViewedFiles(items), {
      initialProps: { items: [diff("a.ts", ["@@ -1 +1 @@\n+one"]), diff("b.ts", ["@@ b"])] },
    });

    act(() => {
      result.current.toggleViewed("a.ts");
      result.current.toggleViewed("b.ts");
    });
    expect([...result.current.viewedFiles]).toEqual(["a.ts", "b.ts"]);

    rerender({ items: [diff("a.ts", ["@@ -1 +1 @@\n+two"]), diff("b.ts", ["@@ b"])] });

    // Only the file that changed underneath the reader loses its mark.
    expect([...result.current.viewedFiles]).toEqual(["b.ts"]);
  });

  it("keeps restored marks when the first diff arrives", () => {
    const { result, rerender } = renderHook(
      ({ items }) => useViewedFiles(items, () => new Set(["a.ts"])),
      {
        initialProps: { items: [] as DisplayItem[] },
      },
    );

    rerender({ items: [diff("a.ts", ["@@ a"])] });

    expect([...result.current.viewedFiles]).toEqual(["a.ts"]);
  });
});
