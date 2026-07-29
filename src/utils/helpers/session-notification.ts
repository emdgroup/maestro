import type { ActiveSessionInfo } from "@/types/bindings";

export type NotifyKind = "done" | "attention" | "failure";

export type SessionSignal = {
  kind: NotifyKind;
  /** Bold first line of the toast. Fixed per kind so a stack of toasts stays scannable. */
  title: string;
  /** Trailing clause of the body, after the session label. */
  detail: string;
};

const LABEL_LIMIT = 40;

/**
 * Which session a notification is about. `task_name` first because that is the name the user
 * typed; the branch is a fallback for sessions started outside a task.
 */
export function sessionLabel(session: ActiveSessionInfo): string {
  const raw =
    session.task_name ||
    session.session_name ||
    session.branch_name ||
    `Session ${session.session_key}`;
  return raw.length > LABEL_LIMIT ? `${raw.slice(0, LABEL_LIMIT - 1)}…` : raw;
}

/** `claude-code` reads as "Claude Code" in a toast; the raw id does not. */
export function agentLabel(session: ActiveSessionInfo): string {
  if (!session.agent_id) return "The agent";
  return session.agent_id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function notificationBody(session: ActiveSessionInfo, detail: string): string {
  return `${sessionLabel(session)} · ${detail}`;
}

/**
 * Maps an `acp://turn-ended` stop reason to a signal. `null` means "do not interrupt".
 *
 * The reason strings come from `maestro-server`'s `command_loop.rs`, plus `auth_required` and
 * `error`. An unrecognised reason stays silent on purpose: we have no copy for it, and a wrong
 * "agent stopped" toast trains the user to ignore the real ones.
 */
export function signalForStopReason(stopReason: string, agent: string): SessionSignal | null {
  switch (stopReason) {
    case "end_turn":
      return { kind: "done", title: "Agent finished", detail: agent };
    case "auth_required":
      return {
        kind: "attention",
        title: "Sign-in required",
        detail: `${agent} needs you to authenticate`,
      };
    case "error":
      return { kind: "failure", title: "Agent stopped", detail: `${agent} ran into an error` };
    case "refusal":
      return { kind: "failure", title: "Agent stopped", detail: `${agent} declined the request` };
    case "max_tokens":
      return { kind: "failure", title: "Agent stopped", detail: `${agent} hit its context limit` };
    case "max_turn_requests":
      return { kind: "failure", title: "Agent stopped", detail: `${agent} hit its turn limit` };
    case "cancelled":
      return null;
    default:
      return null;
  }
}

export function signalForPermission(agent: string, toolTitle: string | null): SessionSignal {
  return {
    kind: "attention",
    title: "Waiting on you",
    detail: toolTitle ? `${agent} wants to: ${toolTitle}` : `${agent} needs permission`,
  };
}

export function signalForElicitation(agent: string): SessionSignal {
  return { kind: "attention", title: "Waiting on you", detail: `${agent} asked a question` };
}
