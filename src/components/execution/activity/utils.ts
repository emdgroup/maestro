import { isAllowKind } from "./PermissionPrompt";
import type {
  ActivityItem,
  PermissionResponseItem,
  ElicitationSummaryItem,
  ToolCallItem,
} from "./types";

export type GroupedDisplayItem =
  | { type: "solo"; item: ActivityItem }
  | { type: "toolGroup"; items: ToolCallItem[] };

export type AgentSectionItem =
  | { type: "agentSection"; items: GroupedDisplayItem[]; showConnector: boolean }
  | { type: "standalone"; item: GroupedDisplayItem };

export function groupIntoAgentSections(items: GroupedDisplayItem[]): AgentSectionItem[] {
  const sections: AgentSectionItem[] = [];
  let currentSection: GroupedDisplayItem[] | null = null;

  for (const gi of items) {
    const isMessage = gi.type === "solo" && gi.item.type === "message";
    const isUserMessage = gi.type === "solo" && gi.item.type === "userMessage";

    if (isUserMessage) {
      if (currentSection) {
        sections.push({ type: "agentSection", items: currentSection, showConnector: false });
        currentSection = null;
      }
      sections.push({ type: "standalone", item: gi });
    } else if (isMessage) {
      if (currentSection) {
        sections.push({ type: "agentSection", items: currentSection, showConnector: false });
      }
      currentSection = [gi];
    } else {
      if (currentSection) {
        currentSection.push(gi);
      } else {
        // Start a new section rather than a standalone — thinking blocks and tool
        // calls that precede the first agent message in a turn would otherwise be
        // filtered out by the renderer's standalone guard.
        currentSection = [gi];
      }
    }
  }

  if (currentSection) {
    sections.push({ type: "agentSection", items: currentSection, showConnector: false });
  }

  for (let i = 0; i < sections.length - 1; i++) {
    const s = sections[i];
    if (s.type === "agentSection" && sections[i + 1].type === "agentSection") {
      s.showConnector = true;
    }
  }

  return sections;
}

export function isRejectOption(payload: Record<string, unknown>, optionId: string): boolean {
  const options = payload.options as Array<{ optionId: string; kind: string }> | undefined;
  const opt = options?.find((o) => o.optionId === optionId);
  return !opt || !isAllowKind(opt.kind);
}

export function getOptionName(
  payload: Record<string, unknown>,
  optionId: string | null,
): string | undefined {
  if (!optionId) return undefined;
  const options = payload.options as Array<{ optionId: string; name: string }> | undefined;
  return options?.find((o) => o.optionId === optionId)?.name;
}

export function isSubagentToolCall(tc: ToolCallItem): boolean {
  return typeof tc.rawInput?.prompt === "string";
}

export function subagentName(tc: ToolCallItem): string {
  const desc = tc.rawInput?.description;
  if (typeof desc === "string" && desc.trim()) return desc.trim();
  return tc.title;
}

export function groupToolCalls(items: ActivityItem[]): GroupedDisplayItem[] {
  const result: GroupedDisplayItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.type === "toolCall") {
      // Child tool calls should not be in items[], but skip defensively
      if (item.item.parentToolCallId) {
        i++;
        continue;
      }
      if (isSubagentToolCall(item.item) || item.item.kind === "switch_mode") {
        result.push({ type: "toolGroup", items: [item.item] });
      } else {
        const group: ToolCallItem[] = [item.item];
        while (i + 1 < items.length) {
          const lookahead = items[i + 1];
          if (
            lookahead.type !== "toolCall" ||
            isSubagentToolCall(lookahead.item) ||
            lookahead.item.parentToolCallId ||
            lookahead.item.kind === "switch_mode"
          )
            break;
          i++;
          group.push(lookahead.item);
        }
        result.push({ type: "toolGroup", items: group });
      }
    } else {
      result.push({ type: "solo", item });
    }
    i++;
  }
  return result;
}

export function mergeLiveItems(
  agentItems: ActivityItem[],
  permissionResponses: Array<{ item: PermissionResponseItem; insertAt: number }>,
  elicitationSummaries: Array<{ item: ElicitationSummaryItem; insertAt: number }>,
): ActivityItem[] {
  if (permissionResponses.length === 0 && elicitationSummaries.length === 0) return agentItems;

  type Slot = { insertAt: number; ai: ActivityItem };
  const slots: Slot[] = [
    ...permissionResponses.map(({ item, insertAt }) => ({
      insertAt,
      ai: { type: "permissionResponse" as const, item },
    })),
    ...elicitationSummaries.map(({ item, insertAt }) => ({
      insertAt,
      ai: { type: "elicitationSummary" as const, item },
    })),
  ].sort((a, b) => a.insertAt - b.insertAt);

  const result: ActivityItem[] = [];
  let si = 0;
  for (let i = 0; i <= agentItems.length; i++) {
    while (si < slots.length && slots[si].insertAt <= i) {
      result.push(slots[si].ai);
      si++;
    }
    if (i < agentItems.length) result.push(agentItems[i]);
  }
  return result;
}

export function formatFieldAnswer(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "boolean") return value ? ["Yes"] : ["No"];
  if (Array.isArray(value)) return value.length > 0 ? value : [];
  return [String(value)];
}
