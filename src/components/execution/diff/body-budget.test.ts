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
  it("renders every file at or under the cap, however many there are", () => {
    const files = Array.from({ length: 200 }, (_, i) => file(`f${i}.ts`, 400));
    expect(planEagerBodies(files).size).toBe(200);
  });

  // Wherever it sits: a lockfile at the top must not hold back the files after it.
  it("defers each file over the cap, and only those", () => {
    const eager = planEagerBodies([file("lock.json", 40_000), file("a.ts", 401), file("b.ts", 50)]);

    expect([...eager]).toEqual(["b.ts"]);
  });

  it("takes the cap it is given", () => {
    expect([...planEagerBodies([file("a.ts", 90), file("b.ts", 110)], 100)]).toEqual(["a.ts"]);
  });

  it("has nothing to plan for an empty review", () => {
    expect(planEagerBodies([]).size).toBe(0);
  });
});
