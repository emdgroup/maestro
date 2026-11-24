import type {
  ActivityState,
  ConfigOption,
  SessionMessagePayload,
  SessionUpdatePayload,
  SubagentUpdatePayload,
  ToolCallItem,
} from "./types";
import type { SubagentFacts } from "./agentMeta";
import {
  applyToolCallUpdate,
  finalizeStreaming,
  replaceToolCall,
  toolCallFromPayload,
} from "./reducerUtils";

/*
  Native ACP subagents. The agent runs each subagent as a child session and reports it on its
  parent with `subagent_update`; the daemon routes the child's own stream here too, tagged with
  `childSessionId`. A subagent is drawn as a tool call card (`kind: "subagent"`) so the stream,
  the Subagents tab and `SubagentCard` handle it like any other row. Its tool calls are keyed by
  its session id as well as their own, since a tool call id is unique within one session only.

  Nothing a subagent says about its model, mode or usage reaches the session's: those describe
  the subagent alone (see `docs/subagents/design.md`).
*/

export const subagentCardId = (sessionId: string) => `subagent:${sessionId}`;
const childCallId = (sessionId: string, toolCallId: string) => `${sessionId}/${toolCallId}`;

export function isWorkingState(state: string | undefined): boolean {
  return state === "running" || state === "requires_action";
}

export function isSubagentWorking(tc: ToolCallItem): boolean {
  return isWorkingState(tc.meta?.subagent?.state);
}

export type SubagentPhase = "running" | "needs" | "done" | "stopped" | "failed" | "unknown";

/** What a subagent card's pill says. */
export function subagentPhase(tc: ToolCallItem): SubagentPhase {
  const facts = tc.meta?.subagent;
  if (!facts) return "unknown";
  if (facts.state === "requires_action") return "needs";
  if (facts.state === "running") return "running";
  switch (facts.outcome) {
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * Applies an update that concerns a subagent. Returns null for one that is the session's own.
 * Every update from a subagent's own session is consumed here, the ones it has no use for too.
 */
export function applySubagentEvent(
  state: ActivityState,
  payload: SessionUpdatePayload,
  raw: Record<string, unknown>,
): ActivityState | null {
  const child = typeof raw.childSessionId === "string" ? raw.childSessionId : undefined;
  if (payload.sessionUpdate === "subagent_update") return upsertSubagent(state, payload, child);
  if (
    payload.sessionUpdate === "session_message" ||
    payload.sessionUpdate === "session_message_chunk"
  ) {
    return applySessionMessage(state, payload, child);
  }
  if (!child) return null;
  return applyChildUpdate(state, child, payload, raw);
}

/** The card of a subagent whose prompt message has this id. */
export function subagentOfPromptMessage(
  state: ActivityState,
  messageId: string,
): ToolCallItem | undefined {
  for (const tc of state.toolCallMap.values()) {
    if (tc.meta?.subagent?.promptMessageId === messageId) return tc;
  }
  return undefined;
}

/** A session that ended took its subagents with it, whatever they last said. */
export function endSubagent(tc: ToolCallItem): ToolCallItem {
  const facts = tc.meta?.subagent;
  if (!facts || !isWorkingState(facts.state)) return tc;
  return withFacts(tc, { ...facts, state: "idle", outcome: "stopped", canCancel: false });
}

function upsertSubagent(
  state: ActivityState,
  payload: SubagentUpdatePayload,
  owner: string | undefined,
): ActivityState {
  const [next, card] = ensureCard(state, payload.sessionId, owner);
  // Replayed history grants nothing, and says nothing of how long a run took.
  const live = !state.isInitializing;
  const facts: SubagentFacts = { ...card.meta!.subagent! };
  if (payload.title) facts.title = payload.title;
  if (payload.capabilities !== undefined) {
    facts.canCancel = live && !!payload.capabilities?.cancel;
  }
  if (payload.state) {
    const wasWorking = isWorkingState(facts.state);
    facts.state = payload.state.state;
    facts.stopReason = payload.state.stopReason ?? undefined;
    facts.error = errorText(payload.state.error);
    if (isWorkingState(facts.state)) {
      if (!wasWorking) {
        facts.outcome = undefined;
        facts.startedAt = live ? Date.now() : undefined;
        facts.endedAt = undefined;
      }
    } else {
      facts.canCancel = false;
      if (facts.state === "idle") {
        facts.outcome = facts.error
          ? "failed"
          : facts.stopReason === "cancelled"
            ? "stopped"
            : "done";
        facts.endedAt = live && facts.startedAt !== undefined ? Date.now() : undefined;
      }
    }
  }
  return replaceCard(next, withFacts(card, facts));
}

function applySessionMessage(
  state: ActivityState,
  payload: SessionMessagePayload,
  transcript: string | undefined,
): ActivityState {
  const text = contentText(payload.content);
  const recipient = payload.recipientSessionId
    ? state.toolCallMap.get(subagentCardId(payload.recipientSessionId))
    : undefined;
  const sender = payload.senderSessionId
    ? state.toolCallMap.get(subagentCardId(payload.senderSessionId))
    : undefined;
  const card = recipient ?? sender;
  // Each message arrives once per transcript it belongs to. The copy in the transcript the card
  // is drawn in is the one kept: the session's own for a subagent of the session, its parent
  // subagent's for a nested one.
  if (!card || transcript !== ownerOf(card)) return state;
  const append = payload.sessionUpdate === "session_message_chunk";
  if (card === recipient) {
    const prompt = append ? `${promptOf(card) ?? ""}${text ?? ""}` : (text ?? promptOf(card));
    const facts = { ...card.meta!.subagent!, promptMessageId: payload.messageId };
    return replaceCard(
      state,
      withFacts({ ...card, rawInput: { ...card.rawInput, prompt } }, facts),
    );
  }
  if (text === null) return state;
  return replaceCard(state, { ...card, content: withReport(card, text, append) });
}

function applyChildUpdate(
  state: ActivityState,
  child: string,
  payload: SessionUpdatePayload,
  raw: Record<string, unknown>,
): ActivityState {
  const [next, card] = ensureCard(state, child, undefined);
  switch (payload.sessionUpdate) {
    case "tool_call": {
      const id = childCallId(child, payload.toolCallId);
      const tc: ToolCallItem = {
        ...toolCallFromPayload(payload, raw, id),
        parentToolCallId: card.toolCallId,
      };
      const toolCallMap = new Map(next.toolCallMap);
      toolCallMap.set(id, tc);
      const ids = card.childToolCallIds ?? [];
      const withChild = ids.includes(id) ? card : { ...card, childToolCallIds: [...ids, id] };
      return replaceCard({ ...next, toolCallMap }, withChild);
    }
    case "tool_call_update": {
      const id = childCallId(child, payload.toolCallId);
      const existing = next.toolCallMap.get(id);
      if (!existing) return next;
      const toolCallMap = new Map(next.toolCallMap);
      toolCallMap.set(id, applyToolCallUpdate(existing, payload, raw));
      // A new card object, so the rows drawing it see the change.
      return replaceCard({ ...next, toolCallMap }, { ...card });
    }
    case "agent_message_chunk":
      // Codex's report: what the subagent says. Claude hands back a message instead.
      return replaceCard(next, { ...card, content: withReport(card, payload.content.text, true) });
    case "plan":
      return replaceCard(next, { ...card, plan: payload.entries });
    case "plan_update":
      return payload.plan.type === "items"
        ? replaceCard(next, { ...card, plan: payload.plan.entries })
        : next;
    case "plan_removed":
      return replaceCard(next, { ...card, plan: undefined });
    case "config_option_update":
      return replaceCard(next, withConfig(card, payload.configOptions));
    default:
      return next;
  }
}

/** The subagent's card, created on first mention. A nested subagent's hangs off its parent's. */
function ensureCard(
  state: ActivityState,
  sessionId: string,
  owner: string | undefined,
): [ActivityState, ToolCallItem] {
  const id = subagentCardId(sessionId);
  const existing = state.toolCallMap.get(id);
  if (existing) return [state, existing];
  const card: ToolCallItem = {
    toolCallId: id,
    title: "Subagent",
    kind: "subagent",
    status: "pending",
    content: [],
    locations: [],
    childToolCallIds: [],
    parentToolCallId: owner ? subagentCardId(owner) : undefined,
    meta: { subagent: { sessionId, state: "unknown", canCancel: false } },
  };
  if (owner) {
    const [withOwner, ownerCard] = ensureCard(state, owner, undefined);
    const toolCallMap = new Map(withOwner.toolCallMap);
    toolCallMap.set(id, card);
    const adopted = {
      ...ownerCard,
      childToolCallIds: [...(ownerCard.childToolCallIds ?? []), id],
    };
    return [replaceCard({ ...withOwner, toolCallMap }, adopted), card];
  }
  const toolCallMap = new Map(state.toolCallMap);
  toolCallMap.set(id, card);
  return [
    {
      ...state,
      toolCallMap,
      items: [...finalizeStreaming(state.items), { type: "toolCall", item: card }],
    },
    card,
  ];
}

/** Stores a card, and refreshes the cards it sits inside so their rows redraw. */
function replaceCard(state: ActivityState, card: ToolCallItem): ActivityState {
  let next = replaceToolCall(state, card);
  let parentId = card.parentToolCallId;
  while (parentId) {
    const parent = next.toolCallMap.get(parentId);
    if (!parent) break;
    next = replaceToolCall(next, { ...parent });
    parentId = parent.parentToolCallId;
  }
  return next;
}

function withFacts(card: ToolCallItem, facts: SubagentFacts): ToolCallItem {
  return {
    ...card,
    title: facts.title || firstLine(promptOf(card)) || "Subagent",
    status: statusOf(facts),
    meta: { ...card.meta, subagent: facts },
  };
}

function withConfig(card: ToolCallItem, options: ConfigOption[]): ToolCallItem {
  const model = options.find((o) => o.category === "model")?.currentValue;
  const agent = options.find((o) => o.id === "agent")?.currentValue;
  return {
    ...card,
    meta: {
      ...card.meta,
      model: model || card.meta?.model,
      agentType: agent && agent !== "default" ? agent : undefined,
    },
  };
}

function statusOf(facts: SubagentFacts): ToolCallItem["status"] {
  if (isWorkingState(facts.state)) return "in_progress";
  switch (facts.outcome) {
    case "stopped":
      return "interrupted";
    case "failed":
      return "error";
    default:
      return "completed";
  }
}

function withReport(card: ToolCallItem, text: string, append: boolean): ToolCallItem["content"] {
  const previous = append
    ? card.content.map((c) => (c.type === "content" ? c.content.text : "")).join("")
    : "";
  return [{ type: "content", content: { type: "text", text: previous + text } }];
}

/** The subagent whose transcript carries this card's messages; none for the session's own. */
function ownerOf(card: ToolCallItem): string | undefined {
  const parent = card.parentToolCallId;
  return parent?.startsWith("subagent:") ? parent.slice("subagent:".length) : undefined;
}

function promptOf(card: ToolCallItem): string | undefined {
  const prompt = card.rawInput?.prompt;
  return typeof prompt === "string" ? prompt : undefined;
}

function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!line) return undefined;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function contentText(content: unknown): string | null {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  const texts = blocks
    .map((b) => (b && typeof b === "object" && "text" in b ? (b as { text: unknown }).text : null))
    .filter((t): t is string => typeof t === "string");
  return texts.length ? texts.join("") : null;
}

function errorText(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (typeof error === "string") return error || "Failed";
  if (typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "Failed";
}
