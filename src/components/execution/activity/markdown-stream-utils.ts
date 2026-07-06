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

export function splitSvgBlocks(text: string): Segment[] {
  if (!text.includes("<svg")) return [{ type: "text", content: text }];

  const fencedRanges: Array<[number, number]> = [];
  const fenceMatches = [...text.matchAll(/^```[^\n]*$/gm)];
  for (let i = 0; i < fenceMatches.length - 1; i += 2) {
    const start = fenceMatches[i].index!;
    const end = fenceMatches[i + 1].index! + fenceMatches[i + 1][0].length;
    fencedRanges.push([start, end]);
  }
  const isInsideFence = (idx: number) => fencedRanges.some(([s, e]) => idx >= s && idx < e);

  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(/<svg[\s\S]*?<\/svg>/gi)) {
    if (isInsideFence(match.index!)) continue;
    if (match.index! > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "svg", content: match[0] });
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}
