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
  /** `boolean` for an on/off option, whose value is `"true"` or `"false"` here. */
  type?: string;
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
  | { type: "terminal"; terminalId: string }
  /** The subagent a call acts on, as Codex's `wait` and `closeAgent` name it. */
  | { type: "session"; sessionId: string };

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

/** ACP plan operations: a session holds any number of plans, each replaced whole by its ID. */
export type PlanOperationUpdate = {
  sessionUpdate: "plan_update";
  plan:
    | { type: "items"; planId: string; entries: PlanEntry[] }
    | { type: "markdown"; planId: string; content: string; path?: string | null };
};

export type PlanRemoved = {
  sessionUpdate: "plan_removed";
  planId: string;
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

/** A content block as ACP sends it inside a compaction summary. Only text is drawn. */
export type CompactionSummaryBlock = { type: string; text?: string };

/**
 * An upsert keyed by `compactionId`. `summary` and `error` are patches: absent leaves the
 * stored value, `null` clears it, and `summary: []` clears it too.
 */
export type CompactionUpdatePayload = {
  sessionUpdate: "compaction_update";
  compactionId: string;
  status: "in_progress" | "completed" | "failed" | "cancelled" | (string & {});
  summary?: CompactionSummaryBlock[] | null;
  error?: string | null;
};

/** One block appended to a compaction's summary. A first-seen id creates the compaction. */
export type CompactionSummaryChunkPayload = {
  sessionUpdate: "compaction_summary_chunk";
  compactionId: string;
  content: CompactionSummaryBlock;
};

/**
 * Fire-and-forget information for the user. Severity is the only structured field: `info`,
 * `warning`, `error`, or a future or `_`-prefixed value. Agents never replay these.
 */
export type NoticePayload = {
  sessionUpdate: "notice";
  severity: string;
  title: string;
  description?: string | null;
};

/**
 * A subagent of this session: ACP runs it as a child session of its own. `title`, `description`
 * and `cwd` are patches; `capabilities` and `state` replace what was stored.
 */
export type SubagentUpdatePayload = {
  sessionUpdate: "subagent_update";
  sessionId: string;
  title?: string | null;
  description?: string | null;
  capabilities?: { cancel?: Record<string, unknown> | null } | null;
  state?: { state: string; stopReason?: string | null; error?: unknown } | null;
};

/** A message between two sessions: a subagent's prompt, or the report it hands back. */
export type SessionMessagePayload = {
  sessionUpdate: "session_message" | "session_message_chunk";
  messageId: string;
  senderSessionId?: string;
  recipientSessionId?: string;
  content?: unknown;
};

export type SessionUpdatePayload =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCallCreated
  | ToolCallUpdate
  | PlanUpdate
  | PlanOperationUpdate
  | PlanRemoved
  | UserMessagePayload
  | UserMessageChunkPayload
  | UsageUpdatePayload
  | ConfigOptionUpdatePayload
  | CanvasCreatePayload
  | CanvasUpdatePayload
  | CanvasDataPayload
  | CompactionUpdatePayload
  | CompactionSummaryChunkPayload
  | NoticePayload
  | SubagentUpdatePayload
  | SessionMessagePayload;

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
  /** The checklist of the subagent this call launched, sent as a plan of its own. */
  plan?: PlanEntry[];
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

export type NoticeItem = {
  id: string;
  /** Title and description: a repeat of the same notice bumps `count` instead of adding a row. */
  key: string;
  severity: string;
  title: string;
  description: string | null;
  count: number;
  /** When the latest repeat arrived. */
  at: number;
};

export type ActivityItem =
  | { type: "message"; item: MessageItem }
  | { type: "thinking"; item: ThinkingItem }
  | { type: "userMessage"; item: UserMessageItem }
  | { type: "toolCall"; item: ToolCallItem }
  | { type: "permissionResponse"; item: PermissionResponseItem }
  | { type: "elicitationSummary"; item: ElicitationSummaryItem }
  | { type: "canvas"; item: CanvasItem }
  | { type: "error"; item: ErrorItem }
  | { type: "notice"; item: NoticeItem };

export type ActivityState = {
  items: ActivityItem[];
  toolCallMap: Map<string, ToolCallItem>;
  lastUserMessageId: string | null;
  plan: PlanEntry[] | null;
  /** The ID of the plan `plan` shows, so its `plan_removed` can clear it. */
  planId: string | null;
  /**
   * The session's Markdown plan, for an agent that sends its plan as prose. The Plan tab shows it
   * when no ExitPlanMode tool call has supplied one.
   */
  planMarkdown: { planId: string; content: string } | null;
  planTitle: string | null;
  isInitializing: boolean;
  isTurnActive: boolean;
  sessionEnded: boolean;
  endReason: "completed" | "failed" | "cancelled" | null;
  suppressUserChunks: boolean;
  canvasMap: Map<string, CanvasSurface>;
  terminalBuffers: Map<string, string>;
  /**
   * The context size from the last `usage_update`. ACP's compaction carries no token counts, so
   * a compaction row reads its "before" from here and its "after" from the next update.
   */
  contextUsed: number | null;
  /** The compaction row that has finished and still waits for that next `usage_update`. */
  compactionAwaitingUsage: string | null;
};

export type AvailableCommand = {
  name: string;
  description: string;
};

export const INITIAL_ACTIVITY_STATE: ActivityState = {
  items: [],
  toolCallMap: new Map(),
  lastUserMessageId: null,
  plan: null,
  planId: null,
  planMarkdown: null,
  planTitle: null,
  isInitializing: true,
  isTurnActive: false,
  sessionEnded: false,
  endReason: null,
  suppressUserChunks: false,
  canvasMap: new Map(),
  terminalBuffers: new Map(),
  contextUsed: null,
  compactionAwaitingUsage: null,
};
