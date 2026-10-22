import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePrefillHidden } from "./LoopEditor";
import { emptyLoopDraft, type LoopDraft } from "./loop-draft";

let answer: (paths: string[]) => void = () => undefined;
vi.mock("@/services/loop.service", () => ({
  sealablePaths: () =>
    new Promise<string[]>((resolve) => {
      answer = resolve;
    }),
  useSealablePathsQuery: () => ({ data: undefined }),
}));

describe("usePrefillHidden", () => {
  it("adds the paths to the draft as it stands when the lookup answers", async () => {
    const onChange = vi.fn();
    const asked: LoopDraft = { ...emptyLoopDraft(), checks: [] };
    const { result, rerender } = renderHook(
      ({ value }) => usePrefillHidden(value, onChange, 1, "main", false),
      { initialProps: { value: asked } },
    );
    result.current("bun test tests/hidden.test.ts tests/other.test.ts");

    // Edited, and one of the paths dismissed, while the lookup was out.
    const edited = { ...asked, setupCommand: "bun install", dismissed: ["tests/other.test.ts"] };
    rerender({ value: edited });
    await act(async () => answer(["tests/hidden.test.ts", "tests/other.test.ts"]));

    expect(onChange).toHaveBeenCalledWith({ ...edited, sealedPaths: ["tests/hidden.test.ts"] });
  });
});
