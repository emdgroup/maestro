/**
 * Anchoring plan annotations to text.
 *
 * A DOM Range dies the moment react-markdown re-renders the plan, which it does while the agent
 * streams. So nothing keeps Ranges: an annotation stores the quoted string plus which occurrence
 * of it was selected, and the Range is rebuilt from the live DOM whenever it is needed.
 */

interface TextPosition {
  node: Text;
  /** Offset of this node's first character within the container's concatenated text. */
  start: number;
}

function collectText(container: HTMLElement): { text: string; positions: TextPosition[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const positions: TextPosition[] = [];
  let text = "";
  let node = walker.nextNode() as Text | null;
  while (node) {
    positions.push({ node, start: text.length });
    text += node.data;
    node = walker.nextNode() as Text | null;
  }
  return { text, positions };
}

/** Map an offset in the concatenated text back to the text node containing it. */
function locate(positions: TextPosition[], offset: number): { node: Text; offset: number } | null {
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i];
    if (offset >= p.start && offset <= p.start + p.node.data.length) {
      return { node: p.node, offset: offset - p.start };
    }
  }
  return null;
}

/**
 * Rebuild a Range for the `occurrence`-th (0-based) appearance of `quote` inside `container`.
 * Returns null when the text is gone — the plan changed under the annotation.
 */
export function rangeForQuote(
  container: HTMLElement,
  quote: string,
  occurrence: number,
): Range | null {
  if (!quote) return null;
  const { text, positions } = collectText(container);

  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(quote, index + 1);
    if (index < 0) return null;
  }

  const from = locate(positions, index);
  const to = locate(positions, index + quote.length);
  if (!from || !to) return null;

  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/**
 * Describe the current selection as a quote anchor, or null when it is empty, collapsed, or
 * reaches outside `container`.
 */
export function quoteFromSelection(
  container: HTMLElement,
  selection: Selection | null,
): { quote: string; occurrence: number } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const quote = range.toString().trim();
  if (!quote) return null;

  // Which occurrence of this text the user picked: count matches ending at or before the
  // selection start, so re-finding it later lands on the same words.
  const { text, positions } = collectText(container);
  const startNode = positions.find((p) => p.node === range.startContainer);
  const absoluteStart = startNode ? startNode.start + range.startOffset : text.indexOf(quote);

  let occurrence = 0;
  let index = text.indexOf(quote);
  while (index >= 0 && index < absoluteStart) {
    occurrence++;
    index = text.indexOf(quote, index + 1);
  }
  if (index < 0) return null;

  return { quote, occurrence };
}

/** Does this point fall inside the range's rendered rects? Highlights are not hit-testable. */
export function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}
