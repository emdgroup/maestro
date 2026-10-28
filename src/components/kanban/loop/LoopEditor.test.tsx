import { describe, expect, it } from "vitest";
import { namedPaths, prefillHidden } from "./LoopEditor";
import { blankCheck, emptyLoopDraft, type LoopDraft } from "./loop-draft";

const files = [
  "package.json",
  "tests/hidden.test.ts",
  "tests/other.test.ts",
  "scripts/db/reset.sh",
];

describe("prefillHidden", () => {
  it("hides what a command names on the loop's branch, but not what the user took out", () => {
    const draft: LoopDraft = {
      ...emptyLoopDraft(),
      sealedPaths: ["**/*.sql", "!tests/fixtures/"],
      dismissed: ["tests/other.test.ts"],
    };
    const next = prefillHidden(
      draft,
      "bun test tests/hidden.test.ts tests/other.test.ts tests/missing.test.ts",
      files,
    );
    // Stored order: rules, picked paths, exceptions.
    expect(next?.sealedPaths).toEqual(["**/*.sql", "tests/hidden.test.ts", "!tests/fixtures/"]);
    expect(prefillHidden(next!, "bun test tests/hidden.test.ts", files)).toBeNull();
  });

  it("takes a folder the branch has files in, and the steps' commands too", () => {
    const step = { ...blankCheck("Setup"), command: "sh scripts/db/ && sh scripts/nope/" };
    const judge = { ...blankCheck("Judge"), command: "tests/hidden.test.ts" };
    expect(namedPaths([step, judge], files)).toEqual(["scripts/db/"]);
  });
});
