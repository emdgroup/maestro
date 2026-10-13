import { describe, expect, it } from "vitest";
import { diffFiles } from "./diff-files";

describe("diffFiles", () => {
  it("counts each file's added and removed lines, headers aside", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "+more",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "+hello",
    ].join("\n");
    expect(diffFiles(diff)).toEqual([
      { path: "src/a.ts", added: 2, removed: 1 },
      { path: "b.txt", added: 1, removed: 0 },
    ]);
    expect(diffFiles("")).toEqual([]);
  });
});
