import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { isWorkingFile, useWorkingFileTracker } from "./useWorkingFileTracker";
import type { ActivityItem, ToolCallItem } from "../activity/types";

function toolCall(partial: Partial<ToolCallItem>): ActivityItem {
  return {
    type: "toolCall",
    item: {
      toolCallId: "tc1",
      title: "Write",
      kind: "edit",
      status: "completed",
      content: [],
      locations: [],
      ...partial,
    },
  } as ActivityItem;
}

function pathsFor(items: ActivityItem[]): string[] {
  const { result } = renderHook(() => useWorkingFileTracker(1, items));
  return result.current.workingFiles.map((f) => f.path).sort();
}

describe("isWorkingFile", () => {
  it("accepts an allow-listed extension inside a hidden directory", () => {
    expect(isWorkingFile(".scratch/notes.md")).toBe(true);
    expect(isWorkingFile("/home/u/proj/.planning/plan.md")).toBe(true);
    expect(isWorkingFile("C:/Users/u/proj/.claude/out.json")).toBe(true);
  });

  it("rejects paths outside a hidden directory", () => {
    expect(isWorkingFile("scratch/notes.md")).toBe(false);
    expect(isWorkingFile("src/lib/utils.ts")).toBe(false);
  });

  it("rejects extensions that are not on the allow-list", () => {
    expect(isWorkingFile(".scratch/binary.exe")).toBe(false);
    expect(isWorkingFile(".scratch/no-extension")).toBe(false);
  });
});

describe("useWorkingFileTracker", () => {
  it("collects paths an agent reports on `locations`", () => {
    expect(pathsFor([toolCall({ locations: [{ path: ".scratch/notes.md" }] })])).toEqual([
      ".scratch/notes.md",
    ]);
  });

  it("collects paths from diff content blocks", () => {
    const items = [
      toolCall({
        kind: "other",
        content: [{ type: "diff", path: ".scratch/a.md", oldText: null, newText: "x" }],
      }),
    ];
    expect(pathsFor(items)).toEqual([".scratch/a.md"]);
  });

  // Regression: agents that send the file on the tool input rather than on `locations`
  // produced no artifacts at all, so neither the Overview card nor the Artifacts tab
  // ever appeared for them.
  it("falls back to the resolved meta filePath when `locations` is empty", () => {
    const items = [toolCall({ locations: [], meta: { filePath: ".scratch/notes.md" } })];
    expect(pathsFor(items)).toEqual([".scratch/notes.md"]);
  });

  it("ignores the meta filePath for non-write kinds", () => {
    const items = [toolCall({ kind: "read", meta: { filePath: ".scratch/notes.md" } })];
    expect(pathsFor(items)).toEqual([]);
  });

  it("does not duplicate a path reported by more than one source", () => {
    const items = [
      toolCall({
        locations: [{ path: ".scratch/notes.md" }],
        meta: { filePath: ".scratch/notes.md" },
        content: [{ type: "diff", path: ".scratch/notes.md", oldText: null, newText: "x" }],
      }),
    ];
    expect(pathsFor(items)).toEqual([".scratch/notes.md"]);
  });
});
