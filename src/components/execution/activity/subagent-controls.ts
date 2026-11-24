import { createContext } from "react";

/**
 * What a subagent card can do in a live session: stop the subagent (ACP `session/cancel` on its
 * own session), and bring forward the request it waits on. `waiting` holds the session ids of the
 * subagents with a request in the queue.
 *
 * Absent outside a live session, which is what hides the Stop button there.
 */
export type SubagentControls = {
  stop: (subagentSessionId: string) => void;
  waiting: ReadonlySet<string>;
  showRequest: (subagentSessionId: string) => void;
};

export const SubagentControlsContext = createContext<SubagentControls | undefined>(undefined);

/** Asks the card of this subagent to scroll into view and open, wherever it is drawn. */
export function revealSubagent(subagentSessionId: string) {
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: subagentSessionId }));
}

export const REVEAL_EVENT = "maestro:reveal-subagent";

/** Each subagent's name by its session id, for the rows that refer to one (Codex's `wait`). */
export const SubagentNamesContext = createContext<ReadonlyMap<string, string>>(new Map());
