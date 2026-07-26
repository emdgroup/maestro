/**
 * Fenced-code ranges per CommonMark: ``` or ~~~ runs of 3+, up to 3 spaces of
 * indent, closed only by a run of the same character at least as long as the
 * opener with nothing else on the line. A backtick fence's info string cannot
 * contain a backtick. An unclosed fence extends to the end of the text — which
 * is exactly what streaming needs: content inside a still-open fence is never a
 * safe place to cut.
 *
 * This is the single fence model shared by every streaming-split helper here.
 * It does not model container nesting (fences inside blockquotes/lists), so a
 * blank line inside such a fence can still be mistaken for a boundary — these
 * helpers only affect transient frames during streaming; the final render
 * always parses the full text with remark, which is authoritative.
 */
function findFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { char: string; len: number; start: number } | null = null;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);

    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      const char = match[1][0];
      const len = match[1].length;
      const info = match[2];
      if (!open) {
        if (!(char === "`" && info.includes("`"))) {
          open = { char, len, start: lineStart };
        }
      } else if (char === open.char && len >= open.len && info.trim() === "") {
        ranges.push([open.start, lineEnd]);
        open = null;
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

export function getCompleteBlocksText(text: string): string {
  if (!text.includes("\n\n")) return "";

  const fences = findFenceRanges(text);
  const insideFence = (idx: number) => fences.some(([s, e]) => idx >= s && idx < e);

  let lastSafeBoundary = -1;
  for (let idx = text.indexOf("\n\n"); idx !== -1; idx = text.indexOf("\n\n", idx + 1)) {
    if (!insideFence(idx)) lastSafeBoundary = idx + 2;
  }

  if (lastSafeBoundary <= 0) return "";
  return text.slice(0, lastSafeBoundary).trimEnd();
}

/**
 * Split a streaming document into sections with stable string identity, so
 * already-rendered sections keep hitting the memoized MarkdownBlock and only the
 * growing tail re-parses. Without this, every completed block re-parses the whole
 * message (O(n²) over a long response), which stalls the renderer during streams.
 *
 * Cuts only at blank-line boundaries (outside code fences) where the next line
 * starts a top-level heading or fence — constructs that can never continue a
 * list, table, or paragraph from the previous section, so splitting there renders
 * identically to parsing the text as one document. As text grows, earlier cut
 * points never move, so section strings are append-stable.
 */
export function splitAtSectionStarts(text: string): string[] {
  const fences = findFenceRanges(text);
  const insideFence = (idx: number) => fences.some(([s, e]) => idx >= s && idx < e);

  const sections: string[] = [];
  let sectionStart = 0;
  let i = text.indexOf("\n\n");

  while (i !== -1) {
    if (insideFence(i)) {
      i = text.indexOf("\n\n", i + 1);
      continue;
    }
    let j = i + 2;
    while (j < text.length && text[j] === "\n") j++;
    const next = text.slice(j, j + 7);
    if (/^#{1,6}[ \t]/.test(next) || next.startsWith("```") || next.startsWith("~~~")) {
      sections.push(text.slice(sectionStart, i));
      sectionStart = j;
    }
    i = text.indexOf("\n\n", j);
  }

  const tail = text.slice(sectionStart);
  if (tail) sections.push(tail);
  return sections.length > 0 ? sections : [text];
}
