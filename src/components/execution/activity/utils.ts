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

export function groupToolCalls(items: ActivityItem[]): GroupedDisplayItem[] {
  const result: GroupedDisplayItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.type === "toolCall") {
      const group: ToolCallItem[] = [item.item];
      while (i + 1 < items.length && items[i + 1].type === "toolCall") {
        i++;
        group.push((items[i] as { type: "toolCall"; item: ToolCallItem }).item);
      }
      result.push({ type: "toolGroup", items: group });
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

export function makeElicitationSummary(
  requestId: string,
  payload: Record<string, unknown>,
  answer: string,
): ElicitationSummaryItem {
  return { id: `elicit-${requestId}`, question: String(payload.message ?? "Elicitation"), answer };
}

export function formatElicitationAnswer(values: Record<string, unknown>): string {
  const parts = Object.values(values).filter((v) => v !== null && v !== undefined && v !== "");
  if (parts.length === 0) return "Submitted";
  return parts.map((v) => (Array.isArray(v) ? v.join(", ") : String(v))).join("; ");
}
