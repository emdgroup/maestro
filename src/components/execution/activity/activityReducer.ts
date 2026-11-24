import type {
  SessionUpdatePayload,
  ActivityState,
  ActivityItem,
  ToolCallItem,
  MessageItem,
  ThinkingItem,
  UserMessageItem,
  CanvasSurface,
  CompactionSummaryBlock,
  ErrorItem,
  NoticeItem,
} from "./types";
import type { CompactionFacts } from "./agentMeta";
import { isMaestroHostTool } from "./utils";
import {
  applyToolCallUpdate,
  finalizeStreaming,
  replaceToolCall,
  toolCallFromPayload,
} from "./reducerUtils";
import {
  applySubagentEvent,
  endSubagent,
  isSubagentWorking,
  subagentOfPromptMessage,
} from "./subagentReducer";
import { limitReachedNotice, parsePlanLimits } from "./planLimits";

export type ActivityAction =
  | { type: "event"; payload: SessionUpdatePayload; raw: Record<string, unknown> }
  | { type: "session_ended" }
  /** `stopReason` as the agent answered the prompt; absent when no prompt ended. */
  | { type: "turn_started" }
  | { type: "turn_ended"; stopReason?: string }
  | { type: "finalize_streaming" }
  | { type: "set_initialized" }
  | { type: "append_error"; stopReason: "error" | "auth_required"; message: string }
  | { type: "terminal_output"; terminalId: string; output: string }
  | { type: "restore_canvases"; surfaces: CanvasSurface[] }
  | { type: "close_canvas"; surfaceId: string };

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

/**
 * Every case here rebuilds `items` around the elements it changes rather than mapping the whole
 * array — `[...items.slice(0, -1), updated]`, not `items.map(...)`. That is a contract, not a
 * style: the wrapper caches in `utils.ts` are keyed on these element objects, and the stream's
 * memoized rows compare on the wrappers. Replacing an untouched element with an equal copy is
 * invisible here and re-renders the entire transcript for one token. The same goes for the
 * `{ ...state }` spreads, which is why `toolCallMap` and `canvasMap` survive a chunk untouched.
 *
 * `AgentStreamContent.render.test.tsx` asserts this directly.
 */
export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case "event":
      return (
        applySubagentEvent(state, action.payload, action.raw) ??
        processEvent(state, action.payload, action.raw)
      );
    case "session_ended": {
      const interrupted = interruptStalledToolCalls(state);
      return {
        ...interrupted,
        items: finalizeStreaming(interrupted.items),
        isTurnActive: false,
        sessionEnded: true,
        endReason: "completed",
      };
    }
    case "turn_started":
      return state.isTurnActive ? state : { ...state, isTurnActive: true };
    case "turn_ended": {
      // Subagents can outlive the turn that started them, and report on their own until they end.
      const interrupted = interruptStalledToolCalls(state, true);
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
      // They arrive in directory order, which is the filesystem's and not the order the agent
      // drew them in. The carousel and the transcript both read insertion order, so sorting here
      // is what puts a restored session back the way the user left it. Files written before
      // `createdAt` existed sort to the front, together, in whatever order they arrived.
      const ordered = [...action.surfaces].sort((a, b) => a.createdAt - b.createdAt);
      for (const surface of ordered) {
        if (!newCanvasMap.has(surface.surfaceId)) {
          newCanvasMap.set(surface.surfaceId, surface);
          newItems.push({ type: "canvas", item: { surfaceId: surface.surfaceId } });
        }
      }
      return { ...state, canvasMap: newCanvasMap, items: newItems };
    }
    case "close_canvas": {
      if (!state.canvasMap.has(action.surfaceId)) return state;
      const newCanvasMap = new Map(state.canvasMap);
      newCanvasMap.delete(action.surfaceId);
      return {
        ...state,
        canvasMap: newCanvasMap,
        items: state.items.filter(
          (entry) => entry.type !== "canvas" || entry.item.surfaceId !== action.surfaceId,
        ),
      };
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

/**
 * Marks what was still running as interrupted. `keepSubagents` spares subagents still working
 * and their tool calls: they outlive the turn, and the session ending is what takes them.
 */
function interruptStalledToolCalls(state: ActivityState, keepSubagents = false): ActivityState {
  const changed = new Map<string, ToolCallItem>();
  for (const [id, tc] of state.toolCallMap) {
    if (tc.meta?.subagent) {
      if (!keepSubagents) {
        const ended = endSubagent(tc);
        if (ended !== tc) changed.set(id, ended);
      }
      continue;
    }
    if (tc.status !== "in_progress" && tc.status !== "pending") continue;
    const owner = tc.parentToolCallId ? state.toolCallMap.get(tc.parentToolCallId) : undefined;
    if (keepSubagents && owner && isSubagentWorking(owner)) continue;
    changed.set(id, { ...tc, status: "interrupted" });
  }
  if (changed.size === 0) return state;
  const toolCallMap = new Map(state.toolCallMap);
  for (const [id, tc] of changed) toolCallMap.set(id, tc);
  const items = state.items.map((item) =>
    item.type === "toolCall" && changed.has(item.item.toolCallId)
      ? { ...item, item: changed.get(item.item.toolCallId)! }
      : item,
  );
  return { ...state, items, toolCallMap };
}

/**
 * The subagent a plan belongs to. Claude names a subagent's checklist `plan:<id>` after the
 * message that carried its prompt; any other plan is the session's own.
 */
function subagentOfPlan(state: ActivityState, planId: string): ToolCallItem | undefined {
  const at = planId.indexOf(":");
  return at < 0 ? undefined : subagentOfPromptMessage(state, planId.slice(at + 1));
}

function processEvent(
  state: ActivityState,
  payload: SessionUpdatePayload,
  raw: Record<string, unknown>,
): ActivityState {
  // Copied, because the chunk cases assign to it; a case that changes nothing returns `state`.
  // No update arms `isTurnActive`: a turn runs from the server's `turn_started` to its
  // `turn_ended`, and an agent can talk with no prompt outstanding, as Claude does when a
  // background subagent finishes. No `turn_ended` follows that.
  const newState = { ...state };

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
        sentAt: Date.now(),
      };
      newState.items = [...finalizeStreaming(newState.items), { type: "message", item: msg }];
      return newState;
    }

    case "tool_call": {
      const items = finalizeStreaming(newState.items);
      const tc = toolCallFromPayload(payload, raw);
      const toolCallMap = new Map(newState.toolCallMap);
      toolCallMap.set(payload.toolCallId, tc);

      // AskUserQuestion is handled by the elicitation panel — suppress the generic tool card.
      // Maestro's own MCP tools are suppressed for the same reason: the canvas surface and the
      // created task are the visible result, and a row about the call adds nothing.
      if (
        tc.meta?.toolName === "AskUserQuestion" ||
        isMaestroHostTool(tc.meta?.toolName, payload.title)
      ) {
        return { ...newState, items, toolCallMap };
      }
      return { ...newState, items: [...items, { type: "toolCall", item: tc }], toolCallMap };
    }

    case "tool_call_update": {
      // Deliberately does not finalize: this frame appends nothing, it revises a card that is
      // already in the list. Ending the message here would split it — a subagent reports
      // progress while the main agent is mid-sentence.
      const existing = newState.toolCallMap.get(payload.toolCallId);
      if (!existing) return state;
      const extractedTitle = extractPlanTitle(payload);
      const next = replaceToolCall(newState, applyToolCallUpdate(existing, payload, raw));
      return extractedTitle ? { ...next, planTitle: extractedTitle } : next;
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

    case "plan_update": {
      const { plan } = payload;
      const subagent = subagentOfPlan(state, plan.planId);
      if (plan.type === "markdown") {
        // A subagent's prose plan has no place on its card.
        if (subagent) return state;
        return { ...newState, planMarkdown: { planId: plan.planId, content: plan.content } };
      }
      if (subagent) return replaceToolCall(state, { ...subagent, plan: plan.entries });
      return { ...newState, plan: plan.entries, planId: plan.planId };
    }

    case "plan_removed": {
      const subagent = subagentOfPlan(state, payload.planId);
      if (subagent) return replaceToolCall(state, { ...subagent, plan: undefined });
      if (payload.planId === state.planMarkdown?.planId) return { ...newState, planMarkdown: null };
      if (payload.planId !== state.planId) return state;
      return { ...newState, plan: null, planId: null };
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
        return state;
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
        title: payload.title,
        html: payload.html,
        theme: payload.theme ?? "maestro",
        sources: payload.sources ?? [],
        data: {},
        createdAt: Date.now(),
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
        newCanvasMap.set(
          payload.surfaceId,
          payload.target
            ? {
                ...existing,
                patch: {
                  seq: (existing.patch?.seq ?? 0) + 1,
                  target: payload.target,
                  html: payload.html,
                },
              }
            : { ...existing, html: payload.html, patch: undefined },
        );
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

    case "compaction_update":
      return upsertCompaction(newState, payload.compactionId, (tc) => {
        const updated = { ...tc, status: compactionStatus(payload.status) ?? tc.status };
        if (payload.summary !== undefined) updated.content = summaryContent([], payload.summary);
        if (payload.error !== undefined) {
          updated.meta = { ...updated.meta, errorText: payload.error ?? undefined };
        }
        return updated;
      });

    case "compaction_summary_chunk":
      return upsertCompaction(newState, payload.compactionId, (tc) => ({
        ...tc,
        content: summaryContent(tc.content, [payload.content]),
      }));

    case "notice": {
      if (typeof payload.title !== "string" || !payload.title) return state;
      return addNotice(newState, payload.severity, payload.title, payload.description || null);
    }

    case "usage_update": {
      // A refused reply is said where the user is reading, once per limit hit.
      const limits = parsePlanLimits(raw);
      const reached = limits && limitReachedNotice(limits);
      const base = reached
        ? addNotice(newState, "warning", reached.title, reached.description, false)
        : newState;
      const awaiting = base.compactionAwaitingUsage;
      if (typeof payload.used !== "number" || (!awaiting && base.contextUsed === payload.used)) {
        return reached ? base : state;
      }
      const next = { ...base, contextUsed: payload.used, compactionAwaitingUsage: null };
      const tc = awaiting ? next.toolCallMap.get(awaiting) : undefined;
      if (!tc?.meta?.compaction) return next;
      return replaceToolCall(next, {
        ...tc,
        meta: { ...tc.meta, compaction: { ...tc.meta.compaction, tokensAfter: payload.used } },
      });
    }

    default:
      return state;
  }
}

/**
 * One notice row per title and description. A repeat moves to the bottom, where the user is
 * reading, rather than bumping a row scrolled out of sight; `bump` says whether it also counts.
 */
function addNotice(
  state: ActivityState,
  severity: string,
  title: string,
  description: string | null,
  bump = true,
): ActivityState {
  const key = `${title}
${description ?? ""}`;
  const at = state.items.findIndex((i) => i.type === "notice" && i.item.key === key);
  const previous = at < 0 ? null : (state.items[at] as { item: NoticeItem }).item;
  if (previous && !bump) return state;
  const items = at < 0 ? state.items : state.items.filter((_, i) => i !== at);
  const notice: NoticeItem = {
    id: previous?.id ?? `notice-${crypto.randomUUID()}`,
    key,
    severity,
    title,
    description,
    count: (previous?.count ?? 0) + 1,
    at: Date.now(),
  };
  return { ...state, items: [...finalizeStreaming(items), { type: "notice", item: notice }] };
}

/** ACP's compaction lifecycle, in the statuses a tool-call row already knows how to draw. */
function compactionStatus(status: string): ToolCallItem["status"] | null {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "cancelled":
      return "interrupted";
    default:
      return null;
  }
}

/**
 * A summary is markdown streamed in pieces, so a chunk extends the text before it rather than
 * starting a block of its own: split blocks would each render as separate, half-formed markdown.
 */
function summaryContent(
  existing: ToolCallItem["content"],
  blocks: CompactionSummaryBlock[] | null,
): ToolCallItem["content"] {
  const content = [...existing];
  for (const block of blocks ?? []) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const last = content[content.length - 1];
    if (last?.type === "content") {
      content[content.length - 1] = {
        type: "content",
        content: { type: "text", text: last.content.text + block.text },
      };
    } else {
      content.push({ type: "content", content: { type: "text", text: block.text } });
    }
  }
  return content;
}

/**
 * Whether the turn this compaction runs in was the user's own `/compact`. Unknown with no user
 * message to go by: a reopened session's history starts at its last compaction.
 */
function compactionTrigger(items: ActivityItem[]): CompactionFacts["trigger"] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "userMessage") {
      return /^\/compact\b/.test(item.item.content.trim()) ? "manual" : "auto";
    }
  }
  return undefined;
}

/**
 * A compaction is drawn as a tool call, so the rail, the expand toggle and the body come for free.
 * ACP gives it no token counts or trigger; both are filled in here from what the stream shows.
 */
function upsertCompaction(
  state: ActivityState,
  compactionId: string,
  patch: (tc: ToolCallItem) => ToolCallItem,
): ActivityState {
  const id = `compaction:${compactionId}`;
  const existing = state.toolCallMap.get(id);
  const updated = patch(
    existing ?? {
      toolCallId: id,
      title: "Compact context",
      kind: "compact",
      status: "in_progress",
      content: [],
      locations: [],
      meta: {
        compaction: {
          trigger: compactionTrigger(state.items),
          tokensBefore: state.contextUsed ?? undefined,
        },
      },
    },
  );
  const settled = updated.status === "completed" && existing?.status !== "completed";
  const next = settled ? { ...state, compactionAwaitingUsage: id } : state;
  if (existing) return replaceToolCall(next, updated);
  const toolCallMap = new Map(next.toolCallMap);
  toolCallMap.set(id, updated);
  return {
    ...next,
    items: [...finalizeStreaming(next.items), { type: "toolCall", item: updated }],
    toolCallMap,
  };
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
