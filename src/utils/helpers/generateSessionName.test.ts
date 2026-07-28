import { describe, it, expect } from "vitest";
import { slugifyName } from "./generateSessionName";

describe("slugifyName", () => {
  it("lowercases and kebabs", () => {
    expect(slugifyName("Fix Windows Path")).toBe("fix-windows-path");
  });

  it("collapses runs of punctuation into a single dash", () => {
    expect(slugifyName("feat: add  --  thing")).toBe("feat-add-thing");
  });

  it("strips leading and trailing dashes", () => {
    expect(slugifyName("  !hello!  ")).toBe("hello");
  });

  it("caps at 50 characters without leaving a trailing dash", () => {
    // 49 chars, then a space — the slice lands on the separator.
    const name = `${"a".repeat(49)} tail`;
    const slug = slugifyName(name);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugifyName("!!!")).toBe("");
  });
});
