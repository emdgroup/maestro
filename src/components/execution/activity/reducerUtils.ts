import type {
  ActivityItem,
  ActivityState,
  ToolCallCreated,
  ToolCallItem,
  ToolCallUpdate,
} from "./types";
import { extractAgentMeta, mergeAgentMeta } from "./agentMeta";

/**
 * Clears `isStreaming` on every item, not just the tail. Resuming a thought that a tool call
 * interrupted re-marks an item that is no longer last, and a tail-only sweep would leave that
 * flag set for the rest of the session — the block shimmers as "Thinking" forever and never
 * becomes collapsible. A resumed thought re-sets the flag on its next chunk, so sweeping the
 * whole list costs nothing.
 */
export function finalizeStreaming(items: ActivityItem[]): ActivityItem[] {
  const isStreaming = (entry: ActivityItem) =>
    (entry.type === "message" || entry.type === "thinking") && entry.item.isStreaming;
  if (!items.some(isStreaming)) return items;
  return items.map((entry) =>
    isStreaming(entry)
      ? ({ type: entry.type, item: { ...entry.item, isStreaming: false } } as ActivityItem)
      : entry,
  );
}

export function replaceToolCall(state: ActivityState, updated: ToolCallItem): ActivityState {
  const toolCallMap = new Map(state.toolCallMap);
  toolCallMap.set(updated.toolCallId, updated);
  const items = state.items.map((i) =>
    i.type === "toolCall" && i.item.toolCallId === updated.toolCallId ? { ...i, item: updated } : i,
  );
  return { ...state, items, toolCallMap };
}

/** The card a `tool_call` frame creates, under the id given. */
export function toolCallFromPayload(
  payload: ToolCallCreated,
  raw: Record<string, unknown>,
  toolCallId = payload.toolCallId,
): ToolCallItem {
  return {
    toolCallId,
    title: payload.title,
    kind: payload.kind,
    status: payload.status ?? "pending",
    content: payload.content ?? [],
    locations: payload.locations ?? [],
    rawInput: payload.rawInput,
    meta: extractAgentMeta(raw),
  };
}

/** A card revised by a `tool_call_update` frame: what the frame carries wins. */
export function applyToolCallUpdate(
  existing: ToolCallItem,
  payload: ToolCallUpdate,
  raw: Record<string, unknown>,
): ToolCallItem {
  const updated = { ...existing };
  // A create frame that could not classify the call omits `kind` altogether;
  // without this the row is stuck on that first guess and every kind-keyed
  // decision — the terminal label, the icon — reads the wrong branch forever.
  if (payload.kind) updated.kind = payload.kind;
  if (payload.title) updated.title = payload.title;
  if (payload.status) updated.status = payload.status === "failed" ? "error" : payload.status;
  if (payload.content) updated.content = payload.content;
  if (payload.locations) updated.locations = payload.locations;
  if (payload.rawInput) updated.rawInput = payload.rawInput;
  // This frame's view of the call wins; earlier frames fill what it omitted.
  updated.meta = mergeAgentMeta(extractAgentMeta(raw), existing.meta ?? {});
  return updated;
}
