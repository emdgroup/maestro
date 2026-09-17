import { createContext } from "react";

/**
 * Opens the create-task dialog prefilled from a piece of an agent's reply.
 *
 * Absent outside the agent stream, which is what hides the action everywhere else — a message
 * rendered in a dashboard mock has no board to create a task on.
 */
export const CreateTaskFromTextContext = createContext<((text: string) => void) | undefined>(
  undefined,
);

/** Longest title the create dialog shows without truncating; the full text becomes the body. */
const MAX_TITLE_LENGTH = 80;

export interface TaskDraft {
  title: string;
  description: string;
}

/**
 * Turn a chunk of an agent's reply into a task draft.
 *
 * The first non-empty line is the title, because that is how both a prose paragraph and a markdown
 * heading read. Leading list and heading markers come off — they belong to the message's
 * formatting, not to the task's name.
 */
export function deriveTaskDraft(text: string): TaskDraft {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const stripped = firstLine
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
  const title =
    stripped.length > MAX_TITLE_LENGTH
      ? `${stripped.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
      : stripped;
  return { title, description: text.trim() };
}
