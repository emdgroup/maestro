/**
 * How a comment names the lines it is about, in the text an agent receives.
 *
 * Shared by the task review's Rework payload and the session panel's annotation prompt, which
 * describe the same thing to the same reader and so must not word it differently.
 */
export function commentAnchor(comment: { lineNumber: number; fromLineNumber?: number }): string {
  const { lineNumber, fromLineNumber } = comment;
  if (lineNumber <= 0) return "";
  if (fromLineNumber && fromLineNumber !== lineNumber) {
    return `lines ${Math.min(fromLineNumber, lineNumber)}-${Math.max(fromLineNumber, lineNumber)}`;
  }
  return `line:${lineNumber}`;
}
