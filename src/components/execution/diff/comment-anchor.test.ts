import { describe, it, expect } from "vitest";
import { commentAnchor } from "./comment-anchor";

describe("commentAnchor", () => {
  it("keeps the single-line wording an agent already sees", () => {
    expect(commentAnchor({ lineNumber: 42 })).toBe("line:42");
    expect(commentAnchor({ lineNumber: 42, fromLineNumber: 42 })).toBe("line:42");
  });

  it("names both ends of a range", () => {
    expect(commentAnchor({ lineNumber: 18, fromLineNumber: 12 })).toBe("lines 12-18");
  });

  // The store keeps the drag's anchor, which is the higher line when the user dragged upward.
  it("orders the range regardless of which end was the anchor", () => {
    expect(commentAnchor({ lineNumber: 12, fromLineNumber: 18 })).toBe("lines 12-18");
  });

  it("gives a file-level comment nothing to anchor to", () => {
    expect(commentAnchor({ lineNumber: 0 })).toBe("");
    expect(commentAnchor({ lineNumber: 0, fromLineNumber: 0 })).toBe("");
  });
});
