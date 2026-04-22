// ACP SessionUpdate payload types — frontend-only, not generated from Rust.
// The backend emits serde_json::Value payloads; these types narrow them.

export type AgentMessageChunk = {
  sessionUpdate: "agent_message_chunk";
  content: { type: "text"; text: string };
};

export type ToolCallCreated = {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: string;
  status: "pending";
};

export type ToolCallContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type ToolCallUpdate = {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: "pending" | "in_progress" | "completed" | "error";
  content?: ToolCallContent;
};

export type PlanEntry = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type PlanUpdate = {
  sessionUpdate: "plan";
  entries: PlanEntry[];
};

export type SessionUpdatePayload =
  | AgentMessageChunk
  | ToolCallCreated
  | ToolCallUpdate
  | PlanUpdate;

// Accumulated state for rendering

export type MessageItem = {
  id: string;
  text: string;
  isStreaming: boolean;
};

export type ToolCallItem = {
  toolCallId: string;
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "error";
  content: ToolCallContent[];
};

export type ActivityItem =
  | { type: "message"; item: MessageItem }
  | { type: "toolCall"; item: ToolCallItem };

export type ActivityState = {
  items: ActivityItem[];
  toolCallMap: Map<string, ToolCallItem>;
  plan: PlanEntry[] | null;
  isInitializing: boolean;
  sessionEnded: boolean;
  endReason: "completed" | "failed" | "cancelled" | null;
};

export const INITIAL_ACTIVITY_STATE: ActivityState = {
  items: [],
  toolCallMap: new Map(),
  plan: null,
  isInitializing: true,
  sessionEnded: false,
  endReason: null,
};
