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
  | { type: "agentSection"; items: GroupedDisplayItem[] }
  | { type: "standalone"; item: GroupedDisplayItem };

/*
  Wrapper caches: the point of the whole file, and the reason the stream does not re-render
  itself for every token.

  `activityReducer` is deliberate about identity — appending a chunk rebuilds `state.items` but
  every element the chunk did not touch keeps its object reference (see the note there). Both
  functions below run over that array on every chunk and, without these caches, allocated a
  fresh `{ type: "solo", item }` for each element every time. New objects are new props, and a
  component whose props are new cannot bail out of re-rendering, so a one-token chunk re-rendered
  the entire transcript — markdown, syntax highlighting and all.

  Keyed by the inner value, so an entry cannot outlive what it wraps and there is nothing to
  evict. Each wrapper is a pure function of its key, which is what makes reuse safe: two callers
  handed the same item are entitled to the same wrapper.

  The outer arrays are still rebuilt on every pass. That is cheap and nobody memoizes on them.
*/
const soloCache = new WeakMap<ActivityItem, GroupedDisplayItem>();
const toolGroupCache = new WeakMap<ToolCallItem, GroupedDisplayItem>();
const standaloneCache = new WeakMap<GroupedDisplayItem, AgentSectionItem>();
const agentSectionCache = new WeakMap<GroupedDisplayItem, AgentSectionItem>();

function solo(item: ActivityItem): GroupedDisplayItem {
  let wrapper = soloCache.get(item);
  if (!wrapper) {
    wrapper = { type: "solo", item };
    soloCache.set(item, wrapper);
  }
  return wrapper;
}

/**
 * Groups grow as their tool calls arrive, and an update replaces the member object, so unlike a
 * solo wrapper a cached group is not determined by its key alone — membership has to be checked.
 * It is a short list, and the check runs only where a full re-render was running before.
 */
function toolGroup(items: ToolCallItem[]): GroupedDisplayItem {
  const cached = toolGroupCache.get(items[0]);
  if (
    cached?.type === "toolGroup" &&
    cached.items.length === items.length &&
    cached.items.every((tc, i) => tc === items[i])
  ) {
    return cached;
  }
  const wrapper: GroupedDisplayItem = { type: "toolGroup", items };
  toolGroupCache.set(items[0], wrapper);
  return wrapper;
}

function standalone(item: GroupedDisplayItem): AgentSectionItem {
  let wrapper = standaloneCache.get(item);
  if (!wrapper) {
    wrapper = { type: "standalone", item };
    standaloneCache.set(item, wrapper);
  }
  return wrapper;
}

/** Same membership check as `toolGroup`, for the same reason: sections grow mid-reply. */
function agentSection(items: GroupedDisplayItem[]): AgentSectionItem {
  const cached = agentSectionCache.get(items[0]);
  if (
    cached?.type === "agentSection" &&
    cached.items.length === items.length &&
    cached.items.every((gi, i) => gi === items[i])
  ) {
    return cached;
  }
  const wrapper: AgentSectionItem = { type: "agentSection", items };
  agentSectionCache.set(items[0], wrapper);
  return wrapper;
}

/**
 * One avatar per reply, not per message item. Only a user message opens a new section: an agent
 * that ends one ACP message and starts another mid-reply — around a tool call, or because it
 * chose to — is still answering the same question, and a second avatar reads as a second speaker.
 */
export function groupIntoAgentSections(items: GroupedDisplayItem[]): AgentSectionItem[] {
  const sections: AgentSectionItem[] = [];
  let currentSection: GroupedDisplayItem[] | null = null;

  for (const gi of items) {
    if (gi.type === "solo" && gi.item.type === "userMessage") {
      if (currentSection) {
        sections.push(agentSection(currentSection));
        currentSection = null;
      }
      sections.push(standalone(gi));
    } else {
      // Thinking blocks and tool calls that precede the first agent message in a turn open a
      // section rather than a standalone — the renderer's standalone guard drops anything that
      // is not a user message.
      (currentSection ??= []).push(gi);
    }
  }

  if (currentSection) {
    sections.push(agentSection(currentSection));
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
        result.push(toolGroup([item.item]));
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
        result.push(toolGroup(group));
      }
    } else {
      result.push(solo(item));
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
