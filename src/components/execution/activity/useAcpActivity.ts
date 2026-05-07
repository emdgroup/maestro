import { useEffect, useReducer } from "react";
import { listen } from "@tauri-apps/api/event";
import { drainAcpReplay } from "@/services/execution.service";
import { INITIAL_ACTIVITY_STATE } from "./types";
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
  | { type: "event"; payload: SessionUpdatePayload }
  | { type: "session_ended" }
  | { type: "turn_ended" }
  | { type: "finalize_streaming" }
  | { type: "set_initialized" };

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case "event":
      return processEvent(state, action.payload);
    case "session_ended":
      return {
        ...state,
        items: finalizeLastStreaming(state.items),
        sessionEnded: true,
        endReason: "completed",
      };
    case "turn_ended":
      return { ...state, items: finalizeLastStreaming(state.items) };
    case "finalize_streaming":
      return { ...state, items: finalizeLastStreaming(state.items) };
    case "set_initialized":
      return { ...state, isInitializing: false };
    default:
      return state;
  }
}

function processEvent(state: ActivityState, payload: SessionUpdatePayload): ActivityState {
  const newState = { ...state, isInitializing: false };

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
      const tc: ToolCallItem = {
        toolCallId: payload.toolCallId,
        title: payload.title,
        kind: payload.kind,
        status: payload.status ?? "pending",
        content: payload.content ?? [],
        locations: payload.locations ?? [],
      };
      const newMap = new Map(newState.toolCallMap);
      newMap.set(payload.toolCallId, tc);
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
        if (payload.status) updated.status = payload.status === "failed" ? "error" : payload.status;
        if (payload.content) updated.content = payload.content;
        if (payload.locations) updated.locations = payload.locations;
        newMap.set(payload.toolCallId, updated);
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
      const items = finalizeLastStreaming(newState.items);
      return { ...newState, items, plan: payload.entries };
    }

    case "user_message": {
      const userMsg: UserMessageItem = {
        id: `user-${crypto.randomUUID()}`,
        content: payload.content,
        sentAt: payload.sentAt,
      };
      return { ...newState, items: [...newState.items, { type: "userMessage", item: userMsg }] };
    }

    case "user_message_chunk": {
      const items = finalizeLastStreaming(newState.items);
      const lastItem = items[items.length - 1];
      if (lastItem && lastItem.type === "userMessage") {
        const updated = { ...lastItem.item, content: lastItem.item.content + payload.content.text };
        return { ...newState, items: [...items.slice(0, -1), { type: "userMessage", item: updated }] };
      }
      const userMsg: UserMessageItem = {
        id: `user-${crypto.randomUUID()}`,
        content: payload.content.text,
        sentAt: Date.now(),
      };
      return { ...newState, items: [...items, { type: "userMessage", item: userMsg }] };
    }

    default:
      return newState;
  }
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
): [ActivityState, React.Dispatch<ActivityAction>] {
  const [state, dispatch] = useReducer(activityReducer, INITIAL_ACTIVITY_STATE);

  useEffect(() => {
    if (logId == null) return;

    const unlisteners = Promise.all([
      listen<unknown>(`acp://session-update/${logId}`, (event) => {
        const payload = event.payload as SessionUpdatePayload;
        dispatch({ type: "event", payload });
      }),
      listen<null>(`acp://session-ended/${logId}`, () => {
        dispatch({ type: "session_ended" });
      }),
      listen<string>(`acp://turn-ended/${logId}`, () => {
        dispatch({ type: "turn_ended" });
      }),
    ]).then((listeners) => {
      drainAcpReplay(logId).catch(console.error);
      return listeners;
    });

    return () => {
      unlisteners.then(([u1, u2, u3]) => {
        u1();
        u2();
        u3();
      });
    };
  }, [logId]);

  return [state, dispatch];
}
