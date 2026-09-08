import { describe, it, expect } from "vitest";
import {
  extractCommandText,
  extractDetailText,
  extractTitle,
  getAcceptMeta,
  splitPermissionOptions,
  toolCallItemFromPayload,
} from "./permission-prompt-utils";

/** An ACP RequestPermissionRequest as it reaches the frontend, minus the fields the card ignores. */
function permission(toolCall: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: "sess-1",
    toolCall,
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
}

const LONG_COMMAND =
  'git log --oneline -n 40 --pretty=format:"%h %ad %s" --date=short -- src/components | head -20';

describe("permission card heading", () => {
  it("takes the agent's description over the command line", () => {
    const payload = permission({
      toolCallId: "t1",
      title: LONG_COMMAND,
      kind: "execute",
      rawInput: { command: LONG_COMMAND, description: "List recent commits touching components" },
    });
    expect(extractTitle(payload)).toBe("List recent commits touching components");
    expect(extractCommandText(payload)).toBe(LONG_COMMAND);
  });

  it("keeps showing the command when the agent sends no description", () => {
    const payload = permission({
      toolCallId: "t2",
      title: LONG_COMMAND,
      kind: "execute",
      rawInput: { command: LONG_COMMAND },
    });
    expect(extractTitle(payload)).toBe(LONG_COMMAND);
    // The heading is already the command — repeating it below would say it twice.
    expect(extractCommandText(payload)).toBeNull();
  });

  it("cleans up an MCP tool name", () => {
    const payload = permission({
      toolCallId: "t3",
      title: "mcp__codegraph__codegraph_explore",
      kind: "other",
    });
    expect(extractTitle(payload)).toBe("Explore (codegraph)");
    expect(extractCommandText(payload)).toBeNull();
  });

  it("describes a search by what it looked for, not the command it was compiled into", () => {
    const payload = permission({
      toolCallId: "t4",
      title: 'grep -n -H "useEffect" C:\\repo\\src\\components',
      kind: "search",
      rawInput: { pattern: "useEffect", path: "C:\\repo\\src\\components", output_mode: "content" },
    });
    expect(extractTitle(payload)).toBe('Search "useEffect" in …/src/components');
    // Not a terminal kind: its title is a command the adapter invented, not one to approve.
    expect(extractCommandText(payload)).toBeNull();
  });

  it("falls back to the legacy tool field when the payload carries no toolCall", () => {
    expect(extractTitle({ tool: "write_file" })).toBe("Write file");
    expect(extractTitle({})).toBe("Action");
    expect(toolCallItemFromPayload({ tool: "write_file" })).toBeNull();
    expect(extractCommandText({ tool: "bash" })).toBeNull();
  });

  it("survives a toolCall with nothing usable on it", () => {
    const payload = permission({ toolCallId: "t5" });
    expect(extractTitle(payload)).toBe("Action");
    expect(extractCommandText(payload)).toBeNull();
  });
});

describe("permission card detail text", () => {
  /** `toolCall.content` as an adapter sends it. */
  function withContent(text: string, rest: Record<string, unknown>): Record<string, unknown> {
    return permission({
      ...rest,
      content: [{ type: "content", content: { type: "text", text } }],
    });
  }

  it("drops content that only repeats the heading", () => {
    const payload = withContent("Generate canvas mock JSON", {
      toolCallId: "d1",
      title: LONG_COMMAND,
      kind: "execute",
      rawInput: { command: LONG_COMMAND, description: "Generate canvas mock JSON" },
    });
    expect(extractTitle(payload)).toBe("Generate canvas mock JSON");
    expect(extractDetailText(payload)).toBeNull();
  });

  it("drops content that only repeats the command", () => {
    const payload = withContent(LONG_COMMAND, {
      toolCallId: "d2",
      title: LONG_COMMAND,
      kind: "execute",
      rawInput: { command: LONG_COMMAND, description: "List recent commits" },
    });
    expect(extractCommandText(payload)).toBe(LONG_COMMAND);
    expect(extractDetailText(payload)).toBeNull();
  });

  it("ignores whitespace when deciding a repeat", () => {
    const payload = withContent("  Generate   canvas\nmock JSON  ", {
      toolCallId: "d3",
      title: LONG_COMMAND,
      kind: "execute",
      rawInput: { command: LONG_COMMAND, description: "Generate canvas mock JSON" },
    });
    expect(extractDetailText(payload)).toBeNull();
  });

  it("keeps content that says something the card is not already showing", () => {
    const payload = withContent("Writes to /tmp, outside the worktree.", {
      toolCallId: "d4",
      title: LONG_COMMAND,
      kind: "execute",
      rawInput: { command: LONG_COMMAND, description: "Generate canvas mock JSON" },
    });
    expect(extractDetailText(payload)).toBe("Writes to /tmp, outside the worktree.");
  });
});

describe("toolCallItemFromPayload", () => {
  it("carries the meta the stream derives, so the card and the row agree", () => {
    const item = toolCallItemFromPayload(
      permission({
        toolCallId: "t6",
        title: "rm -rf build",
        kind: "execute",
        rawInput: { command: "rm -rf build", description: "Clear the build output" },
        _meta: { claudeCode: { toolName: "Bash" } },
      }),
    );
    expect(item?.meta?.description).toBe("Clear the build output");
    expect(item?.meta?.toolName).toBe("Bash");
    // Nothing has run — the prompt is what it is waiting on.
    expect(item?.status).toBe("pending");
  });
});

describe("splitPermissionOptions", () => {
  it("orders the accepts by escalation and picks the first decline", () => {
    const { acceptOptions, rejectOption } = splitPermissionOptions([
      { optionId: "bypassPermissions", name: "Bypass permissions", kind: "allow_always" },
      { optionId: "reject", name: "Keep planning", kind: "reject_once" },
      { optionId: "acceptEdits", name: "Accept edits", kind: "allow_always" },
      { optionId: "default", name: "Accept", kind: "allow_once" },
      { optionId: "reject_always", name: "Never", kind: "reject_always" },
    ]);
    expect(acceptOptions.map((o) => o.optionId)).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
    ]);
    expect(rejectOption?.optionId).toBe("reject");
  });

  it("keeps an option set it has never seen, in the order the agent sent it", () => {
    const { acceptOptions, rejectOption } = splitPermissionOptions([
      { optionId: "proceed", name: "Go ahead", kind: "allow_once" },
      { optionId: "yolo", name: "Never ask again", kind: "allow_always" },
      { optionId: "stop", name: "Not yet", kind: "reject_once" },
    ]);
    expect(acceptOptions.map((o) => o.optionId)).toEqual(["proceed", "yolo"]);
    expect(rejectOption?.optionId).toBe("stop");
    // An unrecognised id still gets an icon and a running order, so the menu renders.
    expect(getAcceptMeta(acceptOptions[0]).description).toBe("");
    expect(getAcceptMeta(acceptOptions[0]).icon).toBeTruthy();
  });

  it("reports nothing for a payload that carries no options", () => {
    expect(splitPermissionOptions(null)).toEqual({ acceptOptions: [], rejectOption: null });
  });
});
