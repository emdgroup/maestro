import type {
  ToolCallContent,
  ToolCallItem,
  ToolCallLocation,
} from "@/components/execution/activity/types.ts";
import { isTerminalKind, rowLabel } from "@/components/execution/activity/ToolCallTimeline.tsx";
import { extractAgentMeta } from "@/components/execution/activity/agentMeta.ts";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export function extractPlanToolCallId(payload: Record<string, unknown>): string | null {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  return typeof toolCall?.toolCallId === "string" ? (toolCall.toolCallId as string) : null;
}

export function extractBodyTextFromToolCallItem(item: ToolCallItem): string | null {
  if (typeof item.rawInput?.plan === "string" && (item.rawInput.plan as string).length > 0) {
    return item.rawInput.plan as string;
  }
  const texts = item.content.flatMap((c) =>
    c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
  );
  return texts.length > 0 ? texts.join("\n\n") : null;
}

export function isAllowKind(kind: string): boolean {
  return kind === "allow_once" || kind === "allow_always";
}

export function extractOptions(payload: Record<string, unknown>): PermissionOption[] | null {
  const opts = payload.options;
  if (!Array.isArray(opts) || opts.length === 0) return null;
  return opts as PermissionOption[];
}

/**
 * The payload's `toolCall` is an ACP ToolCallUpdate — the same object the stream
 * renders a row from. Rebuilding a `ToolCallItem` out of it lets the card reuse
 * `rowLabel` and `rowIcon` rather than keep a second, worse copy of that logic.
 */
export function toolCallItemFromPayload(payload: Record<string, unknown>): ToolCallItem | null {
  const toolCall = payload.toolCall;
  if (toolCall == null || typeof toolCall !== "object" || Array.isArray(toolCall)) return null;
  const tc = toolCall as Record<string, unknown>;
  return {
    toolCallId: typeof tc.toolCallId === "string" ? tc.toolCallId : "",
    title: typeof tc.title === "string" ? tc.title : "",
    kind: typeof tc.kind === "string" ? tc.kind : "other",
    // Nothing has run yet — this prompt is what it is waiting on.
    status: "pending",
    content: Array.isArray(tc.content) ? (tc.content as ToolCallContent[]) : [],
    locations: Array.isArray(tc.locations) ? (tc.locations as ToolCallLocation[]) : [],
    rawInput: tc.rawInput as Record<string, unknown> | undefined,
    meta: extractAgentMeta(tc),
  };
}

/**
 * The heading the stream row would use for the same call: the agent's own
 * description of a shell command, whose ACP title is the command line and is
 * unreadable as a heading. Falls back to the title, so an agent that sends no
 * description is no worse off than before.
 */
export function extractTitle(payload: Record<string, unknown>): string {
  const item = toolCallItemFromPayload(payload);
  const label = item ? rowLabel(item) : "";
  if (label) return label;
  const tool = payload.tool as string | undefined;
  if (!tool) return "Action";
  const map: Record<string, string> = {
    write_file: "Write file",
    read_file: "Read file",
    execute_command: "Run command",
    bash: "Run command",
    shell: "Run command",
    edit_file: "Edit file",
    delete_file: "Delete file",
    create_file: "Create file",
  };
  return map[tool] ?? tool;
}

export function extractBodyText(payload: Record<string, unknown>): string | null {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;

  // ExitPlanMode sends plan text in rawInput.plan
  const rawInput = toolCall?.rawInput as Record<string, unknown> | undefined;
  if (typeof rawInput?.plan === "string" && (rawInput.plan as string).length > 0) {
    return rawInput.plan as string;
  }

  const content = toolCall?.content as Array<Record<string, unknown>> | undefined;
  if (!content) return null;
  const texts: string[] = [];
  for (const c of content) {
    // Direct text block (legacy/simplified format)
    if (c.type === "text" && typeof c.text === "string") {
      texts.push(c.text as string);
    }
    // ACP ToolCallContent::Content format: {type:"content", content:{type:"text", text:"..."}}
    if (c.type === "content") {
      const inner = c.content as Record<string, unknown> | undefined;
      if (inner?.type === "text" && typeof inner.text === "string") {
        texts.push(inner.text as string);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/**
 * The command a shell prompt is deciding on, for the card to show below the
 * heading. Null when the heading *is* the command, so the card never prints the
 * same string twice — the rule `labelBecomesCommand` applies to a stream row.
 */
export function extractCommandText(payload: Record<string, unknown>): string | null {
  const item = toolCallItemFromPayload(payload);
  if (!item || !isTerminalKind(item.kind) || !item.meta?.description) return null;
  return item.title || null;
}

export function isPlanPermission(payload: Record<string, unknown>): boolean {
  const toolCall = payload.toolCall as ToolCallItem | undefined;
  return !!toolCall && isPlanToolCallItem(toolCall);
}

export function isPlanToolCallItem(tc: ToolCallItem): boolean {
  return tc.kind === "switch_mode";
}
