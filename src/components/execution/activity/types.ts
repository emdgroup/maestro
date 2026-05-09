// ACP SessionUpdate payload types — frontend-only, not generated from Rust.
// The backend emits serde_json::Value payloads; these types narrow them.

export type AgentMessageChunk = {
  sessionUpdate: "agent_message_chunk";
  content: { type: "text"; text: string };
};

export type AgentThoughtChunk = {
  sessionUpdate: "agent_thought_chunk";
  content: { type: "text"; text: string };
};

export type ToolCallLocation = {
  path: string;
  line?: number;
};

export type ToolCallCreated = {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: string;
  status?: "pending" | "in_progress" | "completed" | "error";
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
};

export type ToolCallContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type ToolCallUpdate = {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "error";
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
};

export type PlanEntry = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type PlanUpdate = {
  sessionUpdate: "plan";
  entries: PlanEntry[];
  title?: string;
};

export type UsageUpdatePayload = {
  sessionUpdate: "usage_update";
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
};

export type UsageState = {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
};

export type UserMessagePayload = {
  sessionUpdate: "user_message";
  content: string;
  sentAt: number;
};

export type UserMessageChunkPayload = {
  sessionUpdate: "user_message_chunk";
  content: { type: "text"; text: string };
};

export type SessionUpdatePayload =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCallCreated
  | ToolCallUpdate
  | PlanUpdate
  | UserMessagePayload
  | UserMessageChunkPayload
  | UsageUpdatePayload;

// Accumulated state for rendering

export type MessageItem = {
  id: string;
  text: string;
  isStreaming: boolean;
};

export type ThinkingItem = {
  id: string;
  text: string;
  isStreaming: boolean;
};

export type UserMessageItem = {
  id: string;
  content: string;
  attachments?: string[];
  sentAt: number;
};

export type ToolCallItem = {
  toolCallId: string;
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "error";
  content: ToolCallContent[];
  locations: ToolCallLocation[];
};

export type PermissionResponseItem = {
  id: string;
  optionName: string;
  isRejection: boolean;
};

export type ElicitationSummaryItem = {
  id: string;
  question: string;
  answer: string; // e.g. "Yes, proceed" or "Declined"
};

export type ActivityItem =
  | { type: "message"; item: MessageItem }
  | { type: "thinking"; item: ThinkingItem }
  | { type: "userMessage"; item: UserMessageItem }
  | { type: "toolCall"; item: ToolCallItem }
  | { type: "permissionResponse"; item: PermissionResponseItem }
  | { type: "elicitationSummary"; item: ElicitationSummaryItem };

export type ActivityState = {
  items: ActivityItem[];
  toolCallMap: Map<string, ToolCallItem>;
  plan: PlanEntry[] | null;
  planTitle: string | null;
  isInitializing: boolean;
  sessionEnded: boolean;
  endReason: "completed" | "failed" | "cancelled" | null;
};

export type AvailableCommand = {
  name: string;
  description: string;
};

export const INITIAL_ACTIVITY_STATE: ActivityState = {
  items: [],
  toolCallMap: new Map(),
  plan: null,
  planTitle: null,
  isInitializing: true,
  sessionEnded: false,
  endReason: null,
};
