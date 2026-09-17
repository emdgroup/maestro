import { describe, expect, it } from "vitest";
import { deriveTaskDraft } from "./task-draft";

describe("deriveTaskDraft", () => {
  it("takes the first non-empty line as the title and keeps the whole text as the body", () => {
    const draft = deriveTaskDraft("\n\nAdd retries to SFTP reads\n\nThey fail on flaky links.");
    expect(draft.title).toBe("Add retries to SFTP reads");
    expect(draft.description).toBe("Add retries to SFTP reads\n\nThey fail on flaky links.");
  });

  it("strips heading and list markers from the title only", () => {
    expect(deriveTaskDraft("## Fix the parser").title).toBe("Fix the parser");
    expect(deriveTaskDraft("- [ ] Fix the parser").title).toBe("Fix the parser");
    expect(deriveTaskDraft("3. Fix the parser").title).toBe("Fix the parser");
    expect(deriveTaskDraft("## Fix the parser").description).toBe("## Fix the parser");
  });

  it("clips a long first line and marks it as clipped", () => {
    const long = "x".repeat(200);
    const draft = deriveTaskDraft(long);
    expect(draft.title).toHaveLength(80);
    expect(draft.title.endsWith("…")).toBe(true);
    expect(draft.description).toBe(long);
  });

  it("yields an empty title for text with nothing in it", () => {
    expect(deriveTaskDraft("   \n\n ").title).toBe("");
  });
});
