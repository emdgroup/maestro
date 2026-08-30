import { describe, it, expect } from "vitest";
import { diffLineCount, planEagerBodies } from "./body-budget";

const file = (path: string, lines: number) => ({ path, lines });

describe("diffLineCount", () => {
  it("counts every line of every hunk", () => {
    expect(diffLineCount(["@@ -1 +1 @@\n-a\n+b"])).toBe(3);
    expect(diffLineCount(["@@\n+a", "@@\n+b\n+c"])).toBe(5);
  });

  it("is zero for a change git describes without hunks", () => {
    expect(diffLineCount([])).toBe(0);
  });
});

describe("planEagerBodies", () => {
  /**
   * The case that has to stay invisible. Nearly every diff Maestro shows is one agent's worktree,
   * and for those nothing about the budget should be observable at all.
   */
  it("renders every file of an ordinary review", () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.ts`, 60));
    expect(planEagerBodies(files).size).toBe(12);
  });

  it("stops once the budget is spent, and defers the rest", () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`, 100));
    const eager = planEagerBodies(files, 350);

    expect([...eager]).toEqual(["f0.ts", "f1.ts", "f2.ts"]);
  });

  /**
   * A prefix rather than a best fit. Once the budget is gone the review waits from that point on,
   * instead of skipping ahead to whichever later files happen to be small — a reviewer reads top
   * to bottom, and holes in that order are harder to make sense of than a boundary.
   */
  it("does not skip ahead to smaller files once the budget is gone", () => {
    const eager = planEagerBodies(
      [file("big.ts", 300), file("also-big.ts", 300), file("tiny.ts", 1)],
      350,
    );

    expect([...eager]).toEqual(["big.ts"]);
  });

  /**
   * A generated file costs more than the rest of the review together and is rarely what anyone
   * came to read. Skipping it must not spend the budget, or one lockfile at the top of a review
   * would put every file after it behind a button.
   */
  it("defers a file too large to render, and still renders the ones after it", () => {
    const eager = planEagerBodies(
      [file("lock.json", 40_000), file("a.ts", 50), file("b.ts", 50)],
      3500,
      1500,
    );

    expect([...eager]).toEqual(["a.ts", "b.ts"]);
  });

  // Better to spend a little over than to open a review showing nothing but buttons.
  it("always renders the first file it can, even against a tiny budget", () => {
    expect([...planEagerBodies([file("a.ts", 900), file("b.ts", 900)], 10)]).toEqual(["a.ts"]);
  });

  it("has nothing to plan for an empty review", () => {
    expect(planEagerBodies([]).size).toBe(0);
  });
});
