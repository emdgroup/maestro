import type { PendingComment } from "./DiffViewer";
import type { JsonValue } from "@/types/bindings";

export function buildReviewFeedbackBlocks(data: {
  comments: PendingComment[];
  generalFeedback: string;
}): JsonValue[] {
  let feedbackText = "# Review Feedback — Changes Requested\n\n";

  if (data.comments.length > 0) {
    const grouped = new Map<string, string[]>();
    for (const c of data.comments) {
      const list = grouped.get(c.filePath) ?? [];
      list.push(c.lineNumber > 0 ? `line:${c.lineNumber} — ${c.text}` : c.text);
      grouped.set(c.filePath, list);
    }
    for (const [filePath, fileComments] of grouped) {
      feedbackText += `## \`${filePath}\`\n`;
      fileComments.forEach((comment, i) => {
        feedbackText += `### Feedback #${i + 1}\n${comment}\n\n`;
      });
    }
  }

  if (data.generalFeedback) {
    feedbackText += `## General feedback\n${data.generalFeedback}\n`;
  }

  return [{ type: "text", text: feedbackText }];
}
