import type { Annotation } from "@/store/annotationStore";
import type { JsonValue } from "@/types/bindings";

/**
 * Turn annotations into the prompt that asks the agent to answer them.
 *
 * Sibling of `diff/build-review-feedback.ts` and returns the same content-block shape, but this
 * one is a question rather than a review verdict — it must not read as "changes requested".
 */
export function buildAnnotationBlocks(annotations: Annotation[]): JsonValue[] {
  if (annotations.length === 0) return [];

  let text = "# Annotations — please answer\n\n";
  text +=
    "I left the notes below on your work. Answer each one. " +
    "Ask before changing anything you are unsure about.\n\n";

  const diffByFile = new Map<string, string[]>();
  for (const a of annotations) {
    if (a.kind !== "diff") continue;
    const list = diffByFile.get(a.filePath) ?? [];
    list.push(a.lineNumber > 0 ? `line:${a.lineNumber} — ${a.text}` : a.text);
    diffByFile.set(a.filePath, list);
  }

  for (const [filePath, notes] of diffByFile) {
    text += `## \`${filePath}\`\n`;
    for (const note of notes) text += `- ${note}\n`;
    text += "\n";
  }

  const planNotes = annotations.filter((a) => a.kind === "plan");
  if (planNotes.length > 0) {
    text += "## Plan\n";
    for (const a of planNotes) {
      if (a.kind !== "plan") continue;
      text += `> ${a.quote.replace(/\n+/g, " ")}\n\n${a.text}\n\n`;
    }
  }

  return [{ type: "text", text }];
}
