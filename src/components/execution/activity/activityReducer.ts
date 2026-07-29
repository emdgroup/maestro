import type {
  SessionUpdatePayload,
  ActivityState,
  ActivityItem,
  ToolCallItem,
  MessageItem,
  ThinkingItem,
  UserMessageItem,
  CanvasSurface,
  ErrorItem,
} from "./types";
import { extractAgentMeta, mergeAgentMeta } from "./agentMeta";

export type ActivityAction =
  | { type: "event"; payload: SessionUpdatePayload; raw: Record<string, unknown> }
  | { type: "session_ended" }
  | { type: "turn_ended" }
  | { type: "finalize_streaming" }
  | { type: "set_initialized" }
  | { type: "append_error"; stopReason: "error" | "auth_required"; message: string }
  | { type: "terminal_output"; terminalId: string; output: string }
  | { type: "restore_canvases"; surfaces: CanvasSurface[] };

/**
 * `terminalBuffers` is a catch-up buffer, not a scrollback. Its only consumer is
 * `SidePanelContent`, which passes it to `AcpTerminalView` as `initialOutput` so a terminal tab
 * opened after a command started still shows what it missed. Once that view mounts it keeps its
 * own xterm scrollback (5000 lines) and its own `acp://terminal-output` listener, so every byte
 * held here is already held a second time.
 *
 * The bound is sized against that sink rather than against a UX policy: xterm discards anything
 * past 5000 lines on write, which at a typical 80-column line is ~400k chars. Keeping 750k means
 * a late-opening tab still receives more than it can display, while the buffer stops growing for
 * the lifetime of the session.
 */
const CATCH_UP_TRIM_TO_CHARS = 750_000;
/**
 * Trim only once well past the target so the O(n) scan is amortised over many chunks rather than
 * running on every one.
 */
const CATCH_UP_TRIM_TRIGGER_CHARS = 1_000_000;

function trimCatchUpBuffer(buffer: string): string {
  if (buffer.length <= CATCH_UP_TRIM_TRIGGER_CHARS) return buffer;
  // Prefer cutting at a line boundary so the replayed head isn't a partial line.
  const cutFrom = buffer.length - CATCH_UP_TRIM_TO_CHARS;
  const newlineAt = buffer.indexOf("\n", cutFrom);
  return newlineAt === -1 ? buffer.slice(cutFrom) : buffer.slice(newlineAt + 1);
}

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case "event":
      return processEvent(state, action.payload, action.raw);
    case "session_ended": {
      const flushed = flushOrphans(state);
      const interrupted = interruptStalledToolCalls(flushed);
      return {
        ...interrupted,
        items: finalizeStreaming(interrupted.items),
        isTurnActive: false,
        sessionEnded: true,
        endReason: "completed",
      };
    }
    case "turn_ended": {
      const flushed = flushOrphans(state);
      const interrupted = interruptStalledToolCalls(flushed);
      return {
        ...interrupted,
        items: finalizeStreaming(interrupted.items),
        isTurnActive: false,
      };
    }
    case "append_error": {
      const errorItem: ErrorItem = {
        id: `error-${crypto.randomUUID()}`,
        stopReason: action.stopReason,
        message: action.message,
      };
      return { ...state, items: [...state.items, { type: "error", item: errorItem }] };
    }
    case "finalize_streaming":
      return { ...state, items: finalizeStreaming(state.items) };
    case "set_initialized":
      return { ...state, isInitializing: false };
    case "terminal_output": {
      const newBuffers = new Map(state.terminalBuffers);
      const appended = (newBuffers.get(action.terminalId) ?? "") + action.output;
      newBuffers.set(action.terminalId, trimCatchUpBuffer(appended));
      return { ...state, terminalBuffers: newBuffers };
    }
    case "restore_canvases": {
      const newCanvasMap = new Map(state.canvasMap);
      const newItems = [...state.items];
      for (const surface of action.surfaces) {
        if (!newCanvasMap.has(surface.surfaceId)) {
          newCanvasMap.set(surface.surfaceId, surface);
          newItems.push({ type: "canvas", item: { surfaceId: surface.surfaceId } });
        }
      }
      return { ...state, canvasMap: newCanvasMap, items: newItems };
    }
    default:
      return state;
  }
}

/**
 * ACP treats a change in `messageId` as the start of a new message, so a chunk carrying a
 * different id must not extend the block currently streaming.
 *
 * A chunk without an id carries no boundary information: many agents never send the field,
 * and treating that as a boundary would split every one of their messages per chunk. Only a
 * genuine disagreement between two known ids ends a block.
 */
function continuesMessage(existing: string | undefined, incoming: string | undefined): boolean {
  return existing === undefined || incoming === undefined || existing === incoming;
}

function interruptStalledToolCalls(state: ActivityState): ActivityState {
  const stalledIds: string[] = [];
  for (const [id, tc] of state.toolCallMap) {
    if (tc.status === "in_progress" || tc.status === "pending") {
      stalledIds.push(id);
    }
  }
  if (stalledIds.length === 0) return state;
  const newMap = new Map(state.toolCallMap);
  for (const id of stalledIds) {
    const tc = newMap.get(id)!;
    newMap.set(id, { ...tc, status: "interrupted" });
  }
  const items = state.items.map((item) => {
    if (item.type === "toolCall" && stalledIds.includes(item.item.toolCallId)) {
      return { ...item, item: newMap.get(item.item.toolCallId)! };
    }
    return item;
  });
  return { ...state, items, toolCallMap: newMap };
}

function flushOrphans(state: ActivityState): ActivityState {
  if (state.pendingOrphans.size === 0) return state;
  const newMap = new Map(state.toolCallMap);
  let items = state.items;
  for (const [, childIds] of state.pendingOrphans) {
    for (const childId of childIds) {
      const tc = newMap.get(childId);
      if (tc) {
        const adopted = { ...tc, parentToolCallId: undefined };
        newMap.set(childId, adopted);
        items = [...items, { type: "toolCall" as const, item: adopted }];
      }
    }
  }
  return { ...state, items, toolCallMap: newMap, pendingOrphans: new Map() };
}

/**
 * Updates that mean the agent is mid-turn. Everything else — usage, available commands,
 * model/mode/config echoes — arrives *outside* a turn: agents emit them right after
 * `session/load` and after a turn ends. No `turn_ended` follows them, so arming
 * `isTurnActive` there leaves it stuck true for the rest of the session, which reads as
 * "thinking" and keeps the compose bar disabled.
 */
const TURN_PROGRESS_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "user_message",
  "user_message_chunk",
]);

function processEvent(
  state: ActivityState,
  payload: SessionUpdatePayload,
  raw: Record<string, unknown>,
): ActivityState {
  const newState = TURN_PROGRESS_UPDATES.has(payload.sessionUpdate)
    ? { ...state, isTurnActive: true }
    : state;

  switch (payload.sessionUpdate) {
    case "agent_thought_chunk": {
      const messageId = payload.messageId;

      // Fast path: last item is the streaming thought (no interleaving, common case)
      const lastItem = newState.items[newState.items.length - 1];
      if (
        lastItem?.type === "thinking" &&
        lastItem.item.isStreaming &&
        continuesMessage(lastItem.item.messageId, messageId)
      ) {
        const updated = {
          ...lastItem.item,
          text: lastItem.item.text + payload.content.text,
          // Adopt the first id we learn, so a later chunk can still resume this block
          // after an interleaved tool call.
          messageId: lastItem.item.messageId ?? messageId,
        };
        newState.items = [...newState.items.slice(0, -1), { type: "thinking", item: updated }];
        return newState;
      }

      // Interleaved tool calls: a thought can't split across another thought or resume after a
      // message chunk, so the only candidate is the most recent ThinkingItem in the list.
      if (messageId) {
        let idx = newState.items.length - 1;
        while (idx >= 0 && newState.items[idx].type !== "thinking") idx--;
        if (idx >= 0) {
          const existing = newState.items[idx].item as ThinkingItem;
          if (existing.messageId === messageId) {
            const updated = {
              ...existing,
              text: existing.text + payload.content.text,
              isStreaming: true,
            };
            newState.items = [
              ...newState.items.slice(0, idx),
              { type: "thinking", item: updated },
              ...newState.items.slice(idx + 1),
            ];
            return newState;
          }
        }
      }

      // New thought
      const thought: ThinkingItem = {
        id: `thought-${crypto.randomUUID()}`,
        messageId,
        text: payload.content.text,
        isStreaming: true,
      };
      newState.items = [...finalizeStreaming(newState.items), { type: "thinking", item: thought }];
      return newState;
    }

    case "agent_message_chunk": {
      const messageId = payload.messageId;

      // Fast path: the message is still the last item (no interleaving, common case).
      const lastItem = newState.items[newState.items.length - 1];
      if (
        lastItem &&
        lastItem.type === "message" &&
        lastItem.item.isStreaming &&
        continuesMessage(lastItem.item.messageId, messageId)
      ) {
        const updated = {
          ...lastItem.item,
          text: lastItem.item.text + payload.content.text,
          // Adopt the first id we learn, so a later chunk can still resume this block
          // after an interleaved tool call.
          messageId: lastItem.item.messageId ?? messageId,
        };
        newState.items = [...newState.items.slice(0, -1), { type: "message", item: updated }];
        return newState;
      }

      // The id is what ACP says a message *is* — a matching one reattaches wherever the block
      // sits and whether or not it still counts as streaming. Neither being last nor the
      // streaming flag is a protocol fact: both are lost to anything that interleaves, and an
      // agent's chunk boundaries are its own business. Only a message the agent never
      // identified falls back to tail adjacency.
      if (messageId) {
        let idx = newState.items.length - 1;
        while (idx >= 0 && newState.items[idx].type !== "message") idx--;
        if (idx >= 0) {
          const existing = newState.items[idx].item as MessageItem;
          if (existing.messageId === messageId) {
            const updated = {
              ...existing,
              text: existing.text + payload.content.text,
              isStreaming: true,
            };
            newState.items = [
              ...newState.items.slice(0, idx),
              { type: "message", item: updated },
              ...newState.items.slice(idx + 1),
            ];
            return newState;
          }
        }
      }

      // Finalize the streaming block — a thinking block, or the message this chunk just
      // declared finished by carrying a different messageId.
      const msg: MessageItem = {
        id: `msg-${crypto.randomUUID()}`,
        text: payload.content.text,
        isStreaming: true,
        messageId,
      };
      newState.items = [...finalizeStreaming(newState.items), { type: "message", item: msg }];
      return newState;
    }

    case "tool_call": {
      const items = finalizeStreaming(newState.items);
      const meta = extractAgentMeta(raw);
      const parentToolCallId = meta.parentToolCallId;
      const tc: ToolCallItem = {
        toolCallId: payload.toolCallId,
        title: payload.title,
        kind: payload.kind,
        status: payload.status ?? "pending",
        content: payload.content ?? [],
        locations: payload.locations ?? [],
        rawInput: payload.rawInput,
        parentToolCallId,
        meta,
      };
      const newMap = new Map(newState.toolCallMap);
      newMap.set(payload.toolCallId, tc);

      // AskUserQuestion is handled by the elicitation panel — suppress the generic tool card
      if (meta.toolName === "AskUserQuestion") {
        return { ...newState, items, toolCallMap: newMap };
      }

      if (parentToolCallId) {
        const parent = newMap.get(parentToolCallId);
        if (parent) {
          const updatedParent = {
            ...parent,
            childToolCallIds: [...(parent.childToolCallIds ?? []), payload.toolCallId],
          };
          newMap.set(parentToolCallId, updatedParent);
          const updatedItems = items.map((i) =>
            i.type === "toolCall" && i.item.toolCallId === parentToolCallId
              ? { ...i, item: updatedParent }
              : i,
          );
          return { ...newState, items: updatedItems, toolCallMap: newMap };
        }
        // Parent not yet arrived — store as orphan, don't add to items
        const newOrphans = new Map(newState.pendingOrphans);
        const existing = newOrphans.get(parentToolCallId) ?? [];
        newOrphans.set(parentToolCallId, [...existing, payload.toolCallId]);
        return { ...newState, items, toolCallMap: newMap, pendingOrphans: newOrphans };
      }

      // No parent — normal tool call. Check if any orphans were waiting for this id.
      if (newState.pendingOrphans.has(payload.toolCallId)) {
        const orphanIds = newState.pendingOrphans.get(payload.toolCallId)!;
        const updatedTc = {
          ...tc,
          childToolCallIds: [...(tc.childToolCallIds ?? []), ...orphanIds],
        };
        newMap.set(payload.toolCallId, updatedTc);
        const newOrphans = new Map(newState.pendingOrphans);
        newOrphans.delete(payload.toolCallId);
        return {
          ...newState,
          items: [...items, { type: "toolCall", item: updatedTc }],
          toolCallMap: newMap,
          pendingOrphans: newOrphans,
        };
      }

      return {
        ...newState,
        items: [...items, { type: "toolCall", item: tc }],
        toolCallMap: newMap,
      };
    }

    case "tool_call_update": {
      // Deliberately does not finalize: this frame appends nothing, it revises a card that is
      // already in the list. Ending the message here would split it — a background subagent
      // reports progress while the main agent is mid-sentence.
      const items = newState.items;
      const newMap = new Map(newState.toolCallMap);
      const existing = newMap.get(payload.toolCallId);
      if (existing) {
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
        newMap.set(payload.toolCallId, updated);
        const extractedTitle = extractPlanTitle(payload);

        if (existing.parentToolCallId) {
          // Refresh parent reference in items to trigger re-render of SubagentCard
          const parent = newMap.get(existing.parentToolCallId);
          if (parent) {
            const refreshedParent = { ...parent };
            newMap.set(existing.parentToolCallId, refreshedParent);
            const updatedItems = items.map((i) =>
              i.type === "toolCall" && i.item.toolCallId === existing.parentToolCallId
                ? { ...i, item: refreshedParent }
                : i,
            );
            return {
              ...newState,
              items: updatedItems,
              toolCallMap: newMap,
              ...(extractedTitle && { planTitle: extractedTitle }),
            };
          }
          return { ...newState, items, toolCallMap: newMap };
        }

        const updatedItems = items.map((i) =>
          i.type === "toolCall" && i.item.toolCallId === payload.toolCallId
            ? { ...i, item: updated }
            : i,
        );
        return {
          ...newState,
          items: updatedItems,
          toolCallMap: newMap,
          ...(extractedTitle && { planTitle: extractedTitle }),
        };
      }
      return { ...newState, items };
    }

    case "plan": {
      // Same as tool_call_update: the plan renders in its own panel and adds nothing to
      // `items`, so it has no business ending the message being streamed.
      return {
        ...newState,
        plan: payload.entries,
        planTitle: state.planTitle ?? payload.title ?? null,
      };
    }

    case "user_message": {
      const userMsg: UserMessageItem = {
        id: `user-${crypto.randomUUID()}`,
        content: payload.content,
        sentAt: payload.sentAt,
      };
      return {
        ...newState,
        items: [...newState.items, { type: "userMessage", item: userMsg }],
        lastUserMessageId: userMsg.id,
        suppressUserChunks: true,
      };
    }

    case "user_message_chunk": {
      // Suppress agent echo during live sessions — user_message already captured it.
      // Only process during resume/replay where no user_message fires.
      if (state.suppressUserChunks) {
        return newState;
      }
      const items = finalizeStreaming(newState.items);
      const lastItem = items[items.length - 1];
      if (
        lastItem &&
        lastItem.type === "userMessage" &&
        continuesMessage(lastItem.item.messageId, payload.messageId)
      ) {
        const updated = {
          ...lastItem.item,
          content: lastItem.item.content + payload.content.text,
          messageId: lastItem.item.messageId ?? payload.messageId,
        };
        return {
          ...newState,
          items: [...items.slice(0, -1), { type: "userMessage", item: updated }],
        };
      }
      const userMsg: UserMessageItem = {
        id: `user-${crypto.randomUUID()}`,
        content: payload.content.text,
        sentAt: Date.now(),
        messageId: payload.messageId,
      };
      return {
        ...newState,
        items: [...items, { type: "userMessage", item: userMsg }],
        lastUserMessageId: userMsg.id,
      };
    }

    case "canvas_create": {
      const surface: CanvasSurface = {
        surfaceId: payload.surfaceId,
        catalogId: payload.catalogId,
        title: payload.title,
        components: [],
        data: {},
      };
      const newCanvasMap = new Map(newState.canvasMap);
      newCanvasMap.set(payload.surfaceId, surface);
      const items = finalizeStreaming(newState.items);
      return {
        ...newState,
        items: [...items, { type: "canvas", item: { surfaceId: payload.surfaceId } }],
        canvasMap: newCanvasMap,
      };
    }

    case "canvas_update": {
      const newCanvasMap = new Map(newState.canvasMap);
      const existing = newCanvasMap.get(payload.surfaceId);
      if (existing) {
        const componentMap = new Map(existing.components.map((c) => [c.id, c]));
        for (const c of payload.components) {
          componentMap.set(c.id, c);
        }
        newCanvasMap.set(payload.surfaceId, {
          ...existing,
          components: [...componentMap.values()],
        });
      }
      return { ...newState, canvasMap: newCanvasMap };
    }

    case "canvas_data": {
      const newCanvasMap = new Map(newState.canvasMap);
      const existing = newCanvasMap.get(payload.surfaceId);
      if (existing) {
        newCanvasMap.set(payload.surfaceId, {
          ...existing,
          data: { ...existing.data, [payload.path]: payload.value },
        });
      }
      return { ...newState, canvasMap: newCanvasMap };
    }

    default:
      return newState;
  }
}

function extractPlanTitle(payload: {
  title?: string;
  rawInput?: Record<string, unknown>;
}): string | null {
  if (payload.title !== "Ready to code?") return null;
  const plan = payload.rawInput?.plan;
  if (typeof plan !== "string") return null;
  const match = plan.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

/**
 * Clears `isStreaming` on every item, not just the tail. Resuming a thought that a tool call
 * interrupted re-marks an item that is no longer last, and a tail-only sweep would leave that
 * flag set for the rest of the session — the block shimmers as "Thinking" forever and never
 * becomes collapsible. A resumed thought re-sets the flag on its next chunk, so sweeping the
 * whole list costs nothing.
 */
function finalizeStreaming(items: ActivityItem[]): ActivityItem[] {
  const isStreaming = (entry: ActivityItem) =>
    (entry.type === "message" || entry.type === "thinking") && entry.item.isStreaming;
  if (!items.some(isStreaming)) return items;
  return items.map((entry) =>
    isStreaming(entry)
      ? ({ type: entry.type, item: { ...entry.item, isStreaming: false } } as ActivityItem)
      : entry,
  );
}
