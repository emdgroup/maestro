import { describe, it, expect } from "vitest";
import { buildFileTree, treeFileOrder, getDescendantFiles } from "./file-tree";
import type { DiffFileWithName } from "@/types/review";

function files(...names: string[]): DiffFileWithName[] {
  return names.map((fileName) => ({ fileName, hunks: [] }));
}

describe("treeFileOrder", () => {
  it("puts directories before files at each level", () => {
    expect(treeFileOrder(files("zebra.ts", "src/a.ts", "alpha.ts"))).toEqual([
      "src/a.ts",
      "alpha.ts",
      "zebra.ts",
    ]);
  });

  it("sorts siblings by name and recurses", () => {
    expect(
      treeFileOrder(files("src/b/two.ts", "src/a/one.ts", "src/a/alpha.ts", "src/root.ts")),
    ).toEqual(["src/a/alpha.ts", "src/a/one.ts", "src/b/two.ts", "src/root.ts"]);
  });

  // The stack sorts its cards by this, so it has to be the sequence the sidebar renders — which
  // is a depth-first walk of the very same tree.
  it("matches a depth-first walk of buildFileTree", () => {
    const input = files("docs/design.md", "src/acp/transport.rs", "src/acp/reader.rs", "NOTES.md");
    const walked: string[] = [];
    const walk = (nodes: ReturnType<typeof buildFileTree>) => {
      for (const node of nodes) {
        if (node.isDir) walk(node.children ?? []);
        else if (node.fileName) walked.push(node.fileName);
      }
    };
    walk(buildFileTree(input));
    expect(treeFileOrder(input)).toEqual(walked);
  });

  // Untracked files arrive appended to the modified ones; sorting interleaves them by path, which
  // is the visible change this ordering brings.
  it("interleaves files regardless of input order", () => {
    expect(treeFileOrder(files("src/z.ts", "src/a.ts"))).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("is empty for no files", () => {
    expect(treeFileOrder([])).toEqual([]);
  });
});

describe("getDescendantFiles", () => {
  it("collects every leaf under a directory", () => {
    const [srcNode] = buildFileTree(files("src/a/one.ts", "src/b.ts"));
    expect(getDescendantFiles(srcNode).sort()).toEqual(["src/a/one.ts", "src/b.ts"]);
  });

  it("returns the file itself for a leaf", () => {
    const [leaf] = buildFileTree(files("solo.ts"));
    expect(getDescendantFiles(leaf)).toEqual(["solo.ts"]);
  });
});
