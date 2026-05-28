import { useEffect, useReducer } from "react";
import { listen } from "@tauri-apps/api/event";
import { drainAcpReplay } from "@/services/execution.service";
import { INITIAL_ACTIVITY_STATE } from "./types";
import { extractAgentMeta } from "./agentMeta";
import type {
  SessionUpdatePayload,
  ActivityState,
  ActivityItem,
  ToolCallItem,
  MessageItem,
  ThinkingItem,
  UserMessageItem,
} from "./types";

export type ActivityAction =
  | { type: "event"; payload: SessionUpdatePayload; raw: Record<string, unknown> }
  | { type: "session_ended" }
  | { type: "turn_ended" }
  | { type: "finalize_streaming" }
  | { type: "set_initialized" };

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case "event":
      return processEvent(state, action.payload, action.raw);
    case "session_ended": {
      const flushed = flushOrphans(state);
      return {
        ...flushed,
        items: finalizeLastStreaming(flushed.items),
        sessionEnded: true,
        endReason: "completed",
      };
    }
    case "turn_ended": {
      const flushed = flushOrphans(state);
      return { ...flushed, items: finalizeLastStreaming(flushed.items) };
    }
    case "finalize_streaming":
      return { ...state, items: finalizeLastStreaming(state.items) };
    case "set_initialized":
      return { ...state, isInitializing: false };
    default:
      return state;
  }
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

function processEvent(
  state: ActivityState,
  payload: SessionUpdatePayload,
  raw: Record<string, unknown>,
): ActivityState {
  const newState = { ...state };

  switch (payload.sessionUpdate) {
    case "agent_thought_chunk": {
      const lastItem = newState.items[newState.items.length - 1];
      if (lastItem && lastItem.type === "thinking" && lastItem.item.isStreaming) {
        const updated = { ...lastItem.item, text: lastItem.item.text + payload.content.text };
        newState.items = [...newState.items.slice(0, -1), { type: "thinking", item: updated }];
      } else {
        const thought: ThinkingItem = {
          id: `thought-${crypto.randomUUID()}`,
          text: payload.content.text,
          isStreaming: true,
        };
        newState.items = [
          ...finalizeLastStreaming(newState.items),
          { type: "thinking", item: thought },
        ];
      }
      return newState;
    }

    case "agent_message_chunk": {
      const lastItem = newState.items[newState.items.length - 1];
      if (lastItem && lastItem.type === "message" && lastItem.item.isStreaming) {
        const updated = { ...lastItem.item, text: lastItem.item.text + payload.content.text };
        newState.items = [...newState.items.slice(0, -1), { type: "message", item: updated }];
      } else {
        // Finalize any streaming thinking block before starting agent message
        const items = finalizeLastStreaming(newState.items);
        const msg: MessageItem = {
          id: `msg-${crypto.randomUUID()}`,
          text: payload.content.text,
          isStreaming: true,
        };
        newState.items = [...items, { type: "message", item: msg }];
      }
      return newState;
    }

    case "tool_call": {
      const items = finalizeLastStreaming(newState.items);
      const parentToolCallId = extractAgentMeta(raw).parentToolCallId;
      const tc: ToolCallItem = {
        toolCallId: payload.toolCallId,
        title: payload.title,
        kind: payload.kind,
        status: payload.status ?? "pending",
        content: payload.content ?? [],
        locations: payload.locations ?? [],
        rawInput: payload.rawInput,
        parentToolCallId,
      };
      const newMap = new Map(newState.toolCallMap);
      newMap.set(payload.toolCallId, tc);

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
      const items = finalizeLastStreaming(newState.items);
      const newMap = new Map(newState.toolCallMap);
      const existing = newMap.get(payload.toolCallId);
      if (existing) {
        const updated = { ...existing };
        if (payload.title) updated.title = payload.title;
        if (payload.status) updated.status = payload.status === "failed" ? "error" : payload.status;
        if (payload.content) updated.content = payload.content;
        if (payload.locations) updated.locations = payload.locations;
        if (payload.rawInput) updated.rawInput = payload.rawInput;
        const agentMeta = extractAgentMeta(raw);
        const durationMs =
          agentMeta.totalDurationMs ?? (payload as Record<string, unknown>).totalDurationMs;
        if (typeof durationMs === "number") {
          updated.rawInput = {
            ...updated.rawInput,
            totalDurationMs: durationMs,
            totalTokens: agentMeta.totalTokens ?? (payload as Record<string, unknown>).totalTokens,
            totalToolUseCount:
              agentMeta.totalToolUseCount ?? (payload as Record<string, unknown>).totalToolUseCount,
          };
        }
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
      const items = finalizeLastStreaming(newState.items);
      return {
        ...newState,
        items,
        plan: payload.entries,
        planTitle: payload.title ?? state.planTitle,
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
      const items = finalizeLastStreaming(newState.items);
      const lastItem = items[items.length - 1];
      if (lastItem && lastItem.type === "userMessage") {
        const updated = { ...lastItem.item, content: lastItem.item.content + payload.content.text };
        return {
          ...newState,
          items: [...items.slice(0, -1), { type: "userMessage", item: updated }],
        };
      }
      const userMsg: UserMessageItem = {
        id: `user-${crypto.randomUUID()}`,
        content: payload.content.text,
        sentAt: Date.now(),
      };
      return {
        ...newState,
        items: [...items, { type: "userMessage", item: userMsg }],
        lastUserMessageId: userMsg.id,
      };
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

function finalizeLastStreaming(items: ActivityItem[]): ActivityItem[] {
  if (items.length === 0) return items;
  const last = items[items.length - 1];
  if (last.type === "message" && last.item.isStreaming) {
    return [...items.slice(0, -1), { type: "message", item: { ...last.item, isStreaming: false } }];
  }
  if (last.type === "thinking" && last.item.isStreaming) {
    return [
      ...items.slice(0, -1),
      { type: "thinking", item: { ...last.item, isStreaming: false } },
    ];
  }
  return items;
}

export function useAcpActivity(
  logId: number | null,
  sessionUpdateRef?: React.RefObject<((payload: Record<string, unknown>) => void) | undefined>,
): [ActivityState, React.Dispatch<ActivityAction>] {
  const [state, dispatch] = useReducer(activityReducer, INITIAL_ACTIVITY_STATE);

  useEffect(() => {
    if (logId == null) return;

    const unlisteners = Promise.all([
      listen<unknown>(`acp://session-update/${logId}`, (event) => {
        const raw = event.payload as Record<string, unknown>;
        const payload = raw as unknown as SessionUpdatePayload;
        dispatch({ type: "event", payload, raw });
        sessionUpdateRef?.current?.(raw);
      }),
      listen<null>(`acp://session-ended/${logId}`, () => {
        dispatch({ type: "session_ended" });
      }),
      listen<string>(`acp://turn-ended/${logId}`, () => {
        dispatch({ type: "turn_ended" });
      }),
      listen<null>(`acp://replay-drained/${logId}`, () => {
        dispatch({ type: "finalize_streaming" });
        dispatch({ type: "set_initialized" });
      }),
      listen<null>(`acp://spawn-ok/${logId}`, () => {
        dispatch({ type: "set_initialized" });
      }),
    ]).then((listeners) => {
      drainAcpReplay(logId).catch(console.error);
      return listeners;
    });

    return () => {
      unlisteners.then(([u1, u2, u3, u4, u5]) => {
        u1();
        u2();
        u3();
        u4();
        u5();
      });
    };
  }, [logId, sessionUpdateRef]);

  return [state, dispatch];
}
