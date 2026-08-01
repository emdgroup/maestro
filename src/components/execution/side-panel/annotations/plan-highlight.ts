/**
 * Paints annotated plan text with the CSS Custom Highlight API.
 *
 * `CSS.highlights` is one registry per document, so several mounted plan panes would clobber each
 * other's ranges under a shared name. Each layer registers under its own instance id here and the
 * union is repainted, which keeps the single `::highlight(maestro-annotation)` rule in index.css.
 *
 * Unsupported webviews get no highlight — the annotations still exist and are still listed.
 */

const NAME = "maestro-annotation";
const registry = new Map<string, Range[]>();

export function setHighlightRanges(instanceId: string, ranges: Range[]): void {
  registry.set(instanceId, ranges);
  repaint();
}

export function clearHighlightRanges(instanceId: string): void {
  registry.delete(instanceId);
  repaint();
}

function repaint(): void {
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  if (!highlights || !HighlightCtor) return;

  const all = [...registry.values()].flat();
  if (all.length === 0) {
    highlights.delete(NAME);
    return;
  }
  highlights.set(NAME, new HighlightCtor(...all));
}
