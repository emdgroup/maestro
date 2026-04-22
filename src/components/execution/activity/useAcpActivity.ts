import { useEffect, useReducer } from "react";
import { listen } from "@tauri-apps/api/event";
import { INITIAL_ACTIVITY_STATE } from "./types";
import type {
  SessionUpdatePayload,
  ActivityState,
  ActivityItem,
  ToolCallItem,
  MessageItem,
} from "./types";

export type ActivityAction =
  | { type: "event"; payload: SessionUpdatePayload }
  | { type: "session_ended" }
  | { type: "load_from_db"; payloads: SessionUpdatePayload[] };

// Generate unique IDs for message items
let msgCounter = 0;

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case "event":
      return processEvent(state, action.payload);
    case "session_ended":
      return { ...state, sessionEnded: true, endReason: "completed" };
    case "load_from_db": {
      let s = { ...INITIAL_ACTIVITY_STATE, isInitializing: false, sessionEnded: true };
      for (const p of action.payloads) {
        s = processEvent(s, p);
      }
      return { ...s, sessionEnded: true };
    }
    default:
      return state;
  }
}

function processEvent(state: ActivityState, payload: SessionUpdatePayload): ActivityState {
  const newState = { ...state, isInitializing: false };

  switch (payload.sessionUpdate) {
    case "agent_message_chunk": {
      const lastItem = newState.items[newState.items.length - 1];
      if (lastItem && lastItem.type === "message" && lastItem.item.isStreaming) {
        // Append to existing streaming message
        const updated = { ...lastItem.item, text: lastItem.item.text + payload.content.text };
        newState.items = [...newState.items.slice(0, -1), { type: "message", item: updated }];
      } else {
        // Start new message turn
        const msg: MessageItem = {
          id: `msg-${++msgCounter}`,
          text: payload.content.text,
          isStreaming: true,
        };
        newState.items = [...newState.items, { type: "message", item: msg }];
      }
      return newState;
    }

    case "tool_call": {
      // Mark previous streaming message as complete
      const items = finalizeLastMessage(newState.items);
      const tc: ToolCallItem = {
        toolCallId: payload.toolCallId,
        title: payload.title,
        kind: payload.kind,
        status: "pending",
        content: [],
      };
      const newMap = new Map(newState.toolCallMap);
      newMap.set(payload.toolCallId, tc);
      return { ...newState, items: [...items, { type: "toolCall", item: tc }], toolCallMap: newMap };
    }

    case "tool_call_update": {
      const items = finalizeLastMessage(newState.items);
      const newMap = new Map(newState.toolCallMap);
      const existing = newMap.get(payload.toolCallId);
      if (existing) {
        const updated = { ...existing };
        if (payload.status) updated.status = payload.status;
        if (payload.content) updated.content = [...updated.content, payload.content];
        newMap.set(payload.toolCallId, updated);
        // Update in items array too
        const updatedItems = items.map((i) =>
          i.type === "toolCall" && i.item.toolCallId === payload.toolCallId
            ? { ...i, item: updated }
            : i,
        );
        return { ...newState, items: updatedItems, toolCallMap: newMap };
      }
      return { ...newState, items };
    }

    case "plan": {
      const items = finalizeLastMessage(newState.items);
      return { ...newState, items, plan: payload.entries };
    }

    default:
      return newState;
  }
}

function finalizeLastMessage(items: ActivityItem[]): ActivityItem[] {
  if (items.length === 0) return items;
  const last = items[items.length - 1];
  if (last.type === "message" && last.item.isStreaming) {
    return [...items.slice(0, -1), { type: "message", item: { ...last.item, isStreaming: false } }];
  }
  return items;
}

export function useAcpActivity(logId: number | null): ActivityState {
  const [state, dispatch] = useReducer(activityReducer, INITIAL_ACTIVITY_STATE);

  useEffect(() => {
    if (logId == null) return;

    const unlisteners = Promise.all([
      listen<unknown>(`acp://session-update/${logId}`, (event) => {
        dispatch({ type: "event", payload: event.payload as SessionUpdatePayload });
      }),
      listen<null>(`acp://session-ended/${logId}`, () => {
        dispatch({ type: "session_ended" });
      }),
    ]);

    return () => {
      unlisteners.then(([u1, u2]) => {
        u1();
        u2();
      });
    };
  }, [logId]);

  return state;
}
