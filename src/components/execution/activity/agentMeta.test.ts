import { describe, it, expect } from "vitest";

import { extractAgentMeta, mergeAgentMeta } from "./agentMeta";

/** Shapes here are trimmed copies of real `tool_call_update` frames. */
describe("extractAgentMeta — claudeCode", () => {
  it("reads the tool name and the output that came without content[]", () => {
    const meta = extractAgentMeta({
      _meta: { claudeCode: { toolName: "Edit" } },
      rawOutput: "The file src/index.css has been updated successfully.",
      sessionUpdate: "tool_call_update",
    });
    expect(meta.toolName).toBe("Edit");
    expect(meta.output).toBe("The file src/index.css has been updated successfully.");
  });

  it("leaves output alone when content[] will render instead", () => {
    const meta = extractAgentMeta({
      rawOutput: "350\t}\n351\t",
      content: [{ type: "content", content: { type: "text", text: "350\t}" } }],
    });
    expect(meta.output).toBeUndefined();
  });

  it("counts patch lines rather than trusting a summary", () => {
    const meta = extractAgentMeta({
      _meta: {
        claudeCode: {
          toolName: "Edit",
          toolResponse: {
            structuredPatch: [
              { oldStart: 5, lines: ["   ctx", "-  old", "+  new", "+  also"] },
              { oldStart: 40, lines: ["-  gone"] },
            ],
          },
        },
      },
    });
    expect(meta.linesAdded).toBe(2);
    expect(meta.linesRemoved).toBe(2);
  });

  it("prefers the classifier reason over the boilerplate message", () => {
    const meta = extractAgentMeta({
      _meta: {
        claudeCode: {
          nonExecutionKind: "automode-blocked",
          toolResponse: {
            decisionReason: "[Irreversible Local Destruction] robocopy /MIR follows junctions",
            message: "Permission for this action was denied by the auto mode classifier. Reason: …",
          },
        },
      },
      status: "failed",
    });
    expect(meta.blocked).toBe(true);
    expect(meta.errorText).toMatch(/^\[Irreversible/);
  });

  it("falls back to stderr when there was no decision to explain", () => {
    const meta = extractAgentMeta({
      _meta: {
        claudeCode: { toolName: "Bash", toolResponse: { stderr: "error TS2322", stdout: "" } },
      },
    });
    expect(meta.errorText).toBe("error TS2322");
    expect(meta.blocked).toBeUndefined();
  });

  it("pulls read range, match count, usage split, tool stats and git operation", () => {
    const meta = extractAgentMeta({
      _meta: {
        claudeCode: {
          toolName: "Task",
          toolResponse: {
            file: { startLine: 350, numLines: 16, totalLines: 412 },
            numFiles: 3,
            usage: { output_tokens: 3675, cache_read_input_tokens: 42199 },
            toolStats: { readCount: 5, searchCount: 5, bashCount: 2, editFileCount: 0 },
            resolvedModel: "claude-opus-5[1m]",
            agentType: "Explore",
            gitOperation: {
              commit: { kind: "committed", sha: "202f6673" },
              pr: { action: "created", number: 128, url: "https://example.test/pull/128" },
            },
          },
        },
      },
    });
    expect(meta.fileStartLine).toBe(350);
    expect(meta.fileTotalLines).toBe(412);
    expect(meta.matchFileCount).toBe(3);
    expect(meta.outputTokens).toBe(3675);
    expect(meta.cachedTokens).toBe(42199);
    expect(meta.toolStats).toEqual({ reads: 5, searches: 5, bash: 2, edits: 0 });
    expect(meta.model).toBe("claude-opus-5[1m]");
    expect(meta.agentType).toBe("Explore");
    expect(meta.git?.commitSha).toBe("202f6673");
    expect(meta.git?.prNumber).toBe(128);
  });
});

describe("extractAgentMeta — agents other than claude code", () => {
  it("names the tool from any vendor namespace under _meta", () => {
    const meta = extractAgentMeta({ _meta: { gemini: { toolName: "ReadFile" } } });
    expect(meta.toolName).toBe("ReadFile");
  });

  it("derives output, intent and edit counts with no _meta at all", () => {
    const meta = extractAgentMeta({
      kind: "edit",
      rawInput: { description: "Rename the shimmer class" },
      content: [{ type: "diff", path: "a.css", oldText: "one\ntwo", newText: "one\ntwo\nthree" }],
    });
    expect(meta.description).toBe("Rename the shimmer class");
    expect(meta.linesAdded).toBe(3);
    expect(meta.linesRemoved).toBe(2);
  });

  it("joins a structured rawOutput into text", () => {
    const meta = extractAgentMeta({
      rawOutput: [
        { type: "text", text: "first" },
        { type: "tool_reference", tool_name: "mcp__x__y" },
        { type: "text", text: "second" },
      ],
    });
    expect(meta.output).toBe("first\nsecond");
  });

  it("counts searched files from locations when the agent sends no totals", () => {
    const meta = extractAgentMeta({
      kind: "search",
      locations: [{ path: "a.ts" }, { path: "b.ts" }],
    });
    expect(meta.matchFileCount).toBe(2);
  });

  it("lets a vendor extractor win over the generic one", () => {
    const meta = extractAgentMeta({
      _meta: { claudeCode: { toolName: "Grep", toolResponse: { numFiles: 9 } } },
      kind: "search",
      locations: [{ path: "a.ts" }],
    });
    expect(meta.matchFileCount).toBe(9);
  });
});

describe("mergeAgentMeta", () => {
  it("keeps what the newer frame omitted", () => {
    const merged = mergeAgentMeta({ output: "done" }, { toolName: "Edit", output: "stale" });
    expect(merged).toEqual({ output: "done", toolName: "Edit" });
  });
});
