/**
 * Anchoring canvas annotations to elements.
 *
 * The sibling of `plan-anchor.ts`, and it exists for the same reason: a surface is replaced
 * whenever the agent pushes a `canvas_update`, so nothing may hold a DOM node or a rect. What is
 * stored is the element's `id` — which the agent authored and addresses its own updates by — and
 * the geometry is re-read whenever it is needed.
 *
 * The surface lives in a sandboxed frame, so nothing here can read its DOM. The frame reports its
 * own elements (see `canvas-frame.ts`) and `toCanvasNodes` turns that report into the node list
 * every rule below is a pure function over.
 */

import type { FrameNode } from "@/components/execution/activity/canvas/CanvasHtml";

/** Never a hit-test target — decorative, or too small to mean anything. */
const SKIP_TAGS = new Set(["hr", "br", "script", "style", "link", "meta"]);
/** Smaller than this in either direction and an image is a spacer, not a picture. */
const MIN_IMAGE_SIZE = 8;

/**
 * Elements that draw a frame of their own and hold children. Preferred over anything inside them:
 * hovering the value in a stat tile means the tile, not the label.
 */
const FRAME_TAGS = new Set(["section", "article", "fieldset", "form", "table", "dialog"]);

export interface CanvasNode {
  id: string;
  /** The element's tag, shown on the hover chip beside the id. */
  kind: string;
  rect: DOMRect;
  /** Nearest ancestor with an id, as the frame saw it. */
  parentId: string | null;
  frame: boolean;
  layout: boolean;
  skip: boolean;
}

function isFrame(node: FrameNode): boolean {
  return (
    FRAME_TAGS.has(node.tag) ||
    node.role === "region" ||
    /(^|[\s-])card([\s-]|$)/.test(node.className)
  );
}

/**
 * Pure layout wrappers: no text of their own and only element children. Never picked directly —
 * they draw nothing, so the only part exposed to the pointer is the gap between their children,
 * and picking there flashes an outline around half the surface as the pointer crosses it.
 */
function isLayout(node: FrameNode): boolean {
  return !node.ownText && node.childCount > 0;
}

function isSkipped(node: FrameNode): boolean {
  if (SKIP_TAGS.has(node.tag)) return true;
  return (
    node.tag === "img" && (node.rect.width < MIN_IMAGE_SIZE || node.rect.height < MIN_IMAGE_SIZE)
  );
}

/**
 * The frame's report, in host viewport coordinates.
 *
 * The frame does not scroll — its height tracks its content — so a rect inside it plus the
 * iframe's own origin is a viewport rect.
 */
export function toCanvasNodes(
  reported: FrameNode[],
  origin: { left: number; top: number },
): CanvasNode[] {
  return reported
    .filter((node) => node.rect.width > 0 || node.rect.height > 0)
    .map((node) => ({
      id: node.id,
      kind: node.tag,
      rect: new DOMRect(
        node.rect.left + origin.left,
        node.rect.top + origin.top,
        node.rect.width,
        node.rect.height,
      ),
      parentId: node.parentId,
      frame: isFrame(node),
      layout: isLayout(node),
      skip: isSkipped(node),
    }));
}

/** Is `outer` an ancestor of `inner` in the document (not merely overlapping it)? */
function contains(nodes: CanvasNode[], outer: CanvasNode, inner: CanvasNode): boolean {
  if (outer.id === inner.id) return false;
  let parentId = inner.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (parentId === outer.id) return true;
    seen.add(parentId);
    parentId = nodes.find((n) => n.id === parentId)?.parentId ?? null;
  }
  return false;
}

/** A framed element is pickable even when it holds nothing but other elements — a card is a box. */
function pickable(node: CanvasNode): boolean {
  return !node.skip && (node.frame || !node.layout);
}

function hit(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/**
 * What a hover at this point selects: the outermost framed element containing it, or — where there
 * is no frame — the innermost element of any other kind.
 *
 * `drill` (the Alt key) forces the innermost result, which is the only way to reach an element
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

  const innermost = () =>
    under.reduce((best, n) => (contains(nodes, best, n) ? n : best), under[0]).id;

  if (opts.drill) return innermost();

  const frames = under.filter((n) => n.frame);
  if (frames.length === 0) return innermost();
  return frames.reduce((best, n) => (contains(nodes, n, best) ? n : best), frames[0]).id;
}

/**
 * What a marquee selects: everything it touches, reduced to the outermost. Intersection rather
 * than containment, so clipping an element's edge still selects it — requiring full coverage makes
 * anything near the panel edge unselectable.
 */
export function pickInRect(nodes: CanvasNode[], rect: DOMRect): string[] {
  const touched = nodes.filter((n) => pickable(n) && intersects(n.rect, rect));
  return touched
    .filter((n) => !touched.some((other) => contains(nodes, other, n)))
    .map((n) => n.id);
}

export function resolveRects(nodes: CanvasNode[], ids: string[]): DOMRect[] {
  return nodes.filter((n) => ids.includes(n.id)).map((n) => n.rect);
}

/**
 * The annotated elements are gone — the agent replaced them. The note is kept rather than dropped:
 * its text, and the capture taken when it was written, still say something.
 */
export function isStale(nodes: CanvasNode[], ids: string[]): boolean {
  if (ids.length === 0) return false;
  return !ids.some((id) => nodes.some((n) => n.id === id));
}

/** Union of several rects, for placing one outline around a multi-element selection. */
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
    // Both paint outside the DOM the rasteriser walks, so they come out blank.
    if (n.kind === "video" || n.kind === "iframe") kinds.add(n.kind);
  }
  return [...kinds];
}
