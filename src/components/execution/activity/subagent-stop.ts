import { createContext } from "react";
import type { ToolCallItem } from "./types";
import { subagentName } from "./utils";

/**
 * Asks the main agent to stop one background subagent. Neither ACP nor the agent can stop a
 * single subagent from the client, but the agent can: Claude's `TaskStop` takes its id.
 *
 * Absent outside a live session, which is what hides the button there.
 */
export const StopSubagentContext = createContext<((prompt: string) => void) | undefined>(undefined);

export function stopSubagentPrompt(item: ToolCallItem): string {
  const id = item.meta?.agentId ? ` (task id ${item.meta.agentId})` : "";
  return `Stop the background subagent '${subagentName(item)}'${id} now. Leave any other subagents running.`;
}
