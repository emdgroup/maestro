type Segment = { type: "text"; content: string } | { type: "svg"; content: string };

export function getCompleteBlocksText(text: string): string {
  if (!text.includes("\n\n")) return "";

  let fenceCount = 0;
  let lastSafeBoundary = -1;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
      fenceCount++;
      i += 3;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (text[i] === "\n" && i + 1 < text.length && text[i + 1] === "\n") {
      if (fenceCount % 2 === 0) {
        lastSafeBoundary = i + 2;
      }
      i += 2;
      while (i < text.length && text[i] === "\n") i++;
      continue;
    }

    i++;
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
  const sections: string[] = [];
  let insideFence = false;
  let sectionStart = 0;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
      insideFence = !insideFence;
      i += 3;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (!insideFence && text[i] === "\n" && text[i + 1] === "\n") {
      let j = i + 2;
      while (j < text.length && text[j] === "\n") j++;
      const next = text.slice(j, j + 7);
      if (/^#{1,6}[ \t]/.test(next) || next.startsWith("```")) {
        sections.push(text.slice(sectionStart, i));
        sectionStart = j;
      }
      i = j;
      continue;
    }

    i++;
  }

  const tail = text.slice(sectionStart);
  if (tail) sections.push(tail);
  return sections.length > 0 ? sections : [text];
}

/**
 * Ranges that hold code, not renderable markup: fenced ``` blocks and inline
 * `code` spans. A raw <svg> here is a code sample (e.g. a ```tsx block or a
 * `<svg>` mention in prose), not something to lift out and render.
 */
function getCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  const fenceMatches = [...text.matchAll(/^```[^\n]*$/gm)];
  for (let i = 0; i + 1 < fenceMatches.length; i += 2) {
    const start = fenceMatches[i].index!;
    const end = fenceMatches[i + 1].index! + fenceMatches[i + 1][0].length;
    ranges.push([start, end]);
  }

  // Inline code spans: `x`, ``x`y``, etc. The backreference keeps the opening
  // and closing runs the same length.
  for (const match of text.matchAll(/(`+)(?:(?!\1)[\s\S])*?\1/g)) {
    ranges.push([match.index!, match.index! + match[0].length]);
  }

  return ranges;
}

export function splitSvgBlocks(text: string): Segment[] {
  if (!text.includes("<svg")) return [{ type: "text", content: text }];

  const codeRanges = getCodeRanges(text);
  const svgRe = /<svg[\s\S]*?<\/svg>/gi;

  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = svgRe.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    // Skip a match that starts inside, or spans into, a code range. The
    // non-greedy `</svg>` can land in a later fenced block (e.g. a `<svg>`
    // mentioned in prose whose closing tag lives in a following ```tsx block),
    // which would otherwise swallow all the prose in between. Resume scanning
    // past the offending range so a genuine <svg> after it is still found.
    const crossed = codeRanges.find(([s, e]) => start < e && s < end);
    if (crossed) {
      svgRe.lastIndex = Math.max(crossed[1], start + 1);
      continue;
    }

    if (start > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, start) });
    }
    segments.push({ type: "svg", content: match[0] });
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}
