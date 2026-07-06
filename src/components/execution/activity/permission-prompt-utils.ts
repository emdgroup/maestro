import type { ToolCallItem } from "@/components/execution/activity/types.ts";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export function isAllowKind(kind: string): boolean {
  return kind === "allow_once" || kind === "allow_always";
}

export function extractOptions(payload: Record<string, unknown>): PermissionOption[] | null {
  const opts = payload.options;
  if (!Array.isArray(opts) || opts.length === 0) return null;
  return opts as PermissionOption[];
}

export function extractTitle(payload: Record<string, unknown>): string {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  const title = toolCall?.title as string | undefined;
  if (title) return title;
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

export function isPlanPermission(payload: Record<string, unknown>): boolean {
  const toolCall = payload.toolCall as ToolCallItem | undefined;
  return !!toolCall && isPlanToolCallItem(toolCall);
}

export function isPlanToolCallItem(tc: ToolCallItem): boolean {
  return tc.kind === "switch_mode";
}
