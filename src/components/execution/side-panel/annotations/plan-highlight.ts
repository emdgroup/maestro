/**
 * Paints annotated plan text with the CSS Custom Highlight API.
 *
 * `CSS.highlights` is one registry per document, so several mounted plan panes would clobber each
 * other's ranges under a shared name. Each layer registers under its own instance id here and the
 * union is repainted, which keeps a single `::highlight(maestro-annotation)` rule.
 *
 * That rule is injected here rather than written in index.css: lightningcss, which Tailwind
 * optimizes the stylesheet with, does not know the `::highlight()` pseudo-element and warns on
 * every build. Unsupported webviews get no highlight and no rule — the annotations still exist
 * and are still listed.
 */

const NAME = "maestro-annotation";
const RULE = `::highlight(${NAME}) {
  background-color: oklch(from var(--accent) l c h / 0.22);
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
}`;
const registry = new Map<string, Range[]>();
let ruleInjected = false;

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
  if (!ruleInjected) {
    const style = document.createElement("style");
    style.textContent = RULE;
    document.head.append(style);
    ruleInjected = true;
  }

  const all = [...registry.values()].flat();
  if (all.length === 0) {
    highlights.delete(NAME);
    return;
  }
  highlights.set(NAME, new HighlightCtor(...all));
}
