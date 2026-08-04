/**
 * Anchoring canvas annotations to components.
 *
 * The sibling of `plan-anchor.ts`, and it exists for the same reason: a surface is re-rendered
 * whenever the agent pushes a `canvas_update`, so nothing may hold a DOM node or a rect. What is
 * stored is the component id — which the agent authored and addresses its own updates by — and the
 * geometry is re-read from the live DOM whenever it is needed.
 *
 * Reading the DOM and deciding what a point or a rect selects are deliberately separate: only
 * `readNodes` touches layout, so every rule below is a pure function over a node list and can be
 * tested without one.
 */

/** Components that are never a hit-test target — decorative, and too small to mean anything. */
const SKIP = new Set(["Divider", "Icon"]);

/**
 * Pure layout wrappers. Never picked directly: they draw nothing of their own, so the only part of
 * one exposed to the pointer is the `gap` between its children, and picking there would flash an
 * outline around half the surface as the pointer crossed it. Reached by widening from a child.
 */
const LAYOUT = new Set(["Column", "Row", "List"]);

/**
 * Components that draw a frame of their own and hold children. Preferred over anything inside
 * them: hovering the value in a `Card > Text` stat tile means the tile, not the label.
 */
const FRAME = new Set(["Card", "Modal", "Tabs"]);

export interface CanvasNode {
  id: string;
  kind: string;
  rect: DOMRect;
  el: Element;
}

/** Is `outer` an ancestor of `inner` in the render tree (not merely overlapping it)? */
function contains(outer: CanvasNode, inner: CanvasNode): boolean {
  return outer.el !== inner.el && outer.el.contains(inner.el);
}

/**
 * Union of an element's children's rects.
 *
 * The markers are `display: contents`, so they have no box of their own and
 * `getBoundingClientRect` on one is empty. Their children are the component's rendered roots,
 * which is what we actually want to measure. A component that rendered `null` has none, and
 * returning null here is what keeps it from being pickable.
 */
function unionOfChildren(el: Element): DOMRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const child of el.children) {
    const r = child.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }

  if (left === Infinity) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

/** The only function here that reads layout. Everything else works off its result. */
export function readNodes(container: HTMLElement): CanvasNode[] {
  const nodes: CanvasNode[] = [];
  for (const el of container.querySelectorAll("[data-canvas-id]")) {
    const id = el.getAttribute("data-canvas-id");
    const kind = el.getAttribute("data-canvas-kind");
    if (!id || !kind) continue;
    const rect = unionOfChildren(el);
    if (!rect) continue;
    nodes.push({ id, kind, rect, el });
  }
  return nodes;
}

function pickable(node: CanvasNode): boolean {
  return !SKIP.has(node.kind) && !LAYOUT.has(node.kind);
}

function hit(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/**
 * What a hover at this point selects: the outermost framed component containing it, or — where
 * there is no frame, which is every surface built straight out of a `Column` — the innermost
 * component of any other kind.
 *
 * `drill` (the Alt key) forces the innermost result, which is the only way to reach a component
 * inside a card.
 */
export function pickAt(
  nodes: CanvasNode[],
  x: number,
  y: number,
  opts: { drill?: boolean } = {},
): string | null {
  const under = nodes.filter((n) => pickable(n) && hit(n.rect, x, y));
  if (under.length === 0) return null;

  const innermost = () => under.reduce((best, n) => (contains(best, n) ? n : best), under[0]).id;

  if (opts.drill) return innermost();

  const frames = under.filter((n) => FRAME.has(n.kind));
  if (frames.length === 0) return innermost();
  return frames.reduce((best, n) => (contains(n, best) ? n : best), frames[0]).id;
}

/**
 * What a marquee selects: everything it touches, reduced to the outermost. Intersection rather
 * than containment, so clipping a component's edge still selects it — requiring full coverage
 * makes anything near the panel edge unselectable.
 */
export function pickInRect(nodes: CanvasNode[], rect: DOMRect): string[] {
  const touched = nodes.filter((n) => pickable(n) && intersects(n.rect, rect));
  return touched.filter((n) => !touched.some((other) => contains(other, n))).map((n) => n.id);
}

export function resolveRects(nodes: CanvasNode[], ids: string[]): DOMRect[] {
  return nodes.filter((n) => ids.includes(n.id)).map((n) => n.rect);
}

/**
 * The annotated components are gone — the agent replaced them. The note is kept rather than
 * dropped: its text, and the capture taken when it was written, still say something.
 */
export function isStale(nodes: CanvasNode[], ids: string[]): boolean {
  if (ids.length === 0) return false;
  return !ids.some((id) => nodes.some((n) => n.id === id));
}

/** Union of several rects, for placing one outline around a multi-component selection. */
export function boundingRect(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Does this selection contain something no screenshot can capture? */
export function uncapturableKinds(nodes: CanvasNode[], ids: string[]): string[] {
  const kinds = new Set<string>();
  for (const n of nodes) {
    if (!ids.includes(n.id)) continue;
    // The `Html` iframe is sandboxed without `allow-same-origin`, so its document is unreachable
    // from here by any means; `Video` paints outside the DOM. Both rasterise blank.
    if (n.kind === "Html" || n.kind === "Video") kinds.add(n.kind);
  }
  return [...kinds];
}
