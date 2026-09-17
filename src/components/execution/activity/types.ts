// ACP SessionUpdate payload types — frontend-only, not generated from Rust.
// The backend emits serde_json::Value payloads; these types narrow them.

import type { AgentMeta } from "./agentMeta";

export type ConfigOptionValue = {
  name: string;
  value: string;
  description?: string;
};

export type ConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  currentValue: string;
  options: ConfigOptionValue[];
};

export type AgentMessageChunk = {
  sessionUpdate: "agent_message_chunk";
  content: { type: "text"; text: string };
  /** ACP: chunks of one message share this; a change means a new message started. */
  messageId?: string;
};

export type AgentThoughtChunk = {
  sessionUpdate: "agent_thought_chunk";
  content: { type: "text"; text: string };
  messageId?: string;
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
  rawInput?: Record<string, unknown>;
  /** Unstructured tool output — read through `AgentMeta.output`, not directly. */
  rawOutput?: unknown;
};

export type ToolCallContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type ToolCallUpdate = {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  /** ACP lets an update refine the kind — a create frame omits it entirely when it is `other`. */
  kind?: string;
  title?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "error";
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: Record<string, unknown>;
  /** Unstructured tool output — read through `AgentMeta.output`, not directly. */
  rawOutput?: unknown;
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
  /** ACP: chunks of one message share this; a change means a new message started. */
  messageId?: string;
};

export type ConfigOptionUpdatePayload = {
  sessionUpdate: "config_option_update";
  configOptions: ConfigOption[];
};

export type CanvasTheme = "maestro" | "tailwind" | "none";

export type CanvasCreatePayload = {
  sessionUpdate: "canvas_create";
  surfaceId: string;
  title: string;
  html: string;
  theme?: CanvasTheme;
  /** Origins `maestro.fetch` may reach from this surface. */
  sources?: string[];
};

export type CanvasUpdatePayload = {
  sessionUpdate: "canvas_update";
  surfaceId: string;
  html: string;
  /** Element id to replace in the live frame. Without it the whole document is replaced. */
  target?: string;
};

export type CanvasDataPayload = {
  sessionUpdate: "canvas_data";
  surfaceId: string;
  path: string;
  value: unknown;
};

export type SessionUpdatePayload =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCallCreated
  | ToolCallUpdate
  | PlanUpdate
  | UserMessagePayload
  | UserMessageChunkPayload
  | UsageUpdatePayload
  | ConfigOptionUpdatePayload
  | CanvasCreatePayload
  | CanvasUpdatePayload
  | CanvasDataPayload;

// Accumulated state for rendering

export type MessageItem = {
  id: string;
  text: string;
  isStreaming: boolean;
  messageId?: string;
  /** When the first chunk arrived. Absent for messages built outside the reducer. */
  sentAt?: number;
};

export type ThinkingItem = {
  id: string;
  text: string;
  isStreaming: boolean;
  messageId?: string;
};

export type UserMessageItem = {
  id: string;
  content: string;
  attachments?: string[];
  sentAt: number;
  messageId?: string;
};

export type ToolCallItem = {
  toolCallId: string;
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "error" | "interrupted";
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: Record<string, unknown>;
  parentToolCallId?: string;
  childToolCallIds?: string[];
  /** Everything the agent said about the call beyond title/kind/content. */
  meta?: AgentMeta;
};

export type PermissionResponseItem = {
  id: string;
  optionName: string;
  isRejection: boolean;
};

export type ElicitationSummaryItem = {
  id: string;
  message: string;
  declined: boolean;
  fields: Array<{ key: string; question: string; answer: string[] }>;
};

export type CanvasSurface = {
  surfaceId: string;
  title: string;
  html: string;
  theme: CanvasTheme;
  sources: string[];
  data: Record<string, unknown>;
  /**
   * When `canvas_create` opened this surface, and the only thing that can put a restored session's
   * canvases back in the order the agent drew them: they are reloaded from a directory listing,
   * whose order is the filesystem's, not ours. Saved with the file and sorted on restore.
   */
  createdAt: number;
  /**
   * The last targeted `canvas_update`, pushed into the live frame and never merged into `html`.
   * A reload — restoring a saved canvas, or a full replace — shows the authored document instead,
   * the same trade the surface already makes with anything the user typed into it.
   */
  patch?: { seq: number; target: string; html: string };
};

export type CanvasItem = {
  surfaceId: string;
};

export type ErrorItem = {
  id: string;
  stopReason: "error" | "auth_required";
  message: string;
};

export type ActivityItem =
  | { type: "message"; item: MessageItem }
  | { type: "thinking"; item: ThinkingItem }
  | { type: "userMessage"; item: UserMessageItem }
  | { type: "toolCall"; item: ToolCallItem }
  | { type: "permissionResponse"; item: PermissionResponseItem }
  | { type: "elicitationSummary"; item: ElicitationSummaryItem }
  | { type: "canvas"; item: CanvasItem }
  | { type: "error"; item: ErrorItem };

export type ActivityState = {
  items: ActivityItem[];
  toolCallMap: Map<string, ToolCallItem>;
  pendingOrphans: Map<string, string[]>;
  lastUserMessageId: string | null;
  plan: PlanEntry[] | null;
  planTitle: string | null;
  isInitializing: boolean;
  isTurnActive: boolean;
  sessionEnded: boolean;
  endReason: "completed" | "failed" | "cancelled" | null;
  suppressUserChunks: boolean;
  canvasMap: Map<string, CanvasSurface>;
  terminalBuffers: Map<string, string>;
};

export type AvailableCommand = {
  name: string;
  description: string;
};

export const INITIAL_ACTIVITY_STATE: ActivityState = {
  items: [],
  toolCallMap: new Map(),
  pendingOrphans: new Map(),
  lastUserMessageId: null,
  plan: null,
  planTitle: null,
  isInitializing: true,
  isTurnActive: false,
  sessionEnded: false,
  endReason: null,
  suppressUserChunks: false,
  canvasMap: new Map(),
  terminalBuffers: new Map(),
};
