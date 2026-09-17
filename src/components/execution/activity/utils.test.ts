import { describe, expect, it } from "vitest";
import { groupIntoAgentSections, groupToolCalls, isMaestroHostTool } from "./utils";
import type { ActivityItem } from "./types";

function message(text: string): ActivityItem {
  return { type: "message", item: { id: `m-${text}`, text, isStreaming: false } };
}

function thinking(text: string): ActivityItem {
  return { type: "thinking", item: { id: `t-${text}`, text, isStreaming: false } };
}

function userMessage(text: string): ActivityItem {
  return { type: "userMessage", item: { id: `u-${text}`, content: text, sentAt: 0 } };
}

function toolCall(toolCallId: string): ActivityItem {
  return {
    type: "toolCall",
    item: {
      toolCallId,
      title: toolCallId,
      kind: "read",
      status: "completed",
      content: [],
      locations: [],
    },
  };
}

const sections = (items: ActivityItem[]) => groupIntoAgentSections(groupToolCalls(items));

describe("isMaestroHostTool", () => {
  it("recognises Claude Code's namespaced tool names", () => {
    expect(isMaestroHostTool("mcp__maestro__canvas_update", "maestro - canvas_update")).toBe(true);
    expect(isMaestroHostTool("mcp__maestro__create_task", undefined)).toBe(true);
  });

  it("falls back to the title when the adapter reports no tool name", () => {
    expect(isMaestroHostTool(undefined, "maestro - canvas_await")).toBe(true);
    expect(isMaestroHostTool(undefined, "maestro (list_tasks)")).toBe(true);
  });

  it("leaves everything else visible", () => {
    expect(isMaestroHostTool("mcp__github__create_task", "github - create_task")).toBe(false);
    expect(isMaestroHostTool("Bash", "maestro-server --version")).toBe(false);
    expect(isMaestroHostTool(undefined, "Read")).toBe(false);
    expect(isMaestroHostTool(undefined, undefined)).toBe(false);
  });

  it("keeps a title that says something about the call, rather than naming it", () => {
    // Suppressing these is how a failure the user needs to see disappears from the transcript.
    expect(isMaestroHostTool(undefined, "maestro: create_task failed")).toBe(false);
    expect(isMaestroHostTool(undefined, "Retrying maestro canvas_update")).toBe(false);
    expect(isMaestroHostTool(undefined, "maestro create_task (3 of 4)")).toBe(false);
  });
});

describe("groupIntoAgentSections", () => {
  it("keeps one reply in a single section across a tool call", () => {
    const result = sections([message("before"), toolCall("tc-1"), message("after")]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("agentSection");
    expect(result[0].type === "agentSection" && result[0].items).toHaveLength(3);
  });

  it("opens a new section only at a user message", () => {
    const result = sections([
      userMessage("ask"),
      thinking("hmm"),
      message("reply"),
      userMessage("again"),
      message("second reply"),
    ]);

    expect(result.map((s) => s.type)).toEqual([
      "standalone",
      "agentSection",
      "standalone",
      "agentSection",
    ]);
  });

  it("puts a tool call that precedes the first message in a section, not a standalone", () => {
    // The renderer drops any standalone that is not a user message.
    const result = sections([toolCall("tc-1"), message("done")]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("agentSection");
  });
});
