import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** dnd-kit is still placing the dropped card this long after the drop. */
const DROP_SETTLE_MS = 400;

/** Where a card sat, in its column's content, so scrolling or resizing does not make it stale. */
export interface CardSpot {
  column: string;
  x: number;
  y: number;
}

export type CardMove = "enter" | "fly" | "reflow" | null;

/** What a card has to do, given where it sat at the last commit and whether it was ever drawn. */
export function cardMove(prev: CardSpot | undefined, seen: boolean, now: CardSpot): CardMove {
  // Not drawn last time but known: a filter had hidden it, which is not news.
  if (!prev) return seen ? null : "enter";
  if (prev.column !== now.column) return "fly";
  return prev.y !== now.y ? "reflow" : null;
}

/** A card's position in the board's coordinates, for a column that may be scrolled. */
function onBoard(root: HTMLElement, spot: CardSpot) {
  const scroller = root.querySelector<HTMLElement>(`[data-column-scroll="${spot.column}"]`);
  if (!scroller) return null;
  const box = scroller.getBoundingClientRect();
  const origin = root.getBoundingClientRect();
  return {
    x: box.left - origin.left + spot.x - scroller.scrollLeft,
    y: box.top - origin.top + spot.y - scroller.scrollTop,
  };
}

/** The card travels as a copy above the columns, whose overflow would clip the real one. */
function fly(
  root: HTMLElement,
  layer: HTMLElement,
  card: HTMLElement,
  prev: CardSpot,
  now: CardSpot,
) {
  const from = onBoard(root, prev);
  const to = onBoard(root, now);
  if (!from || !to) return;
  const copy = card.cloneNode(true) as HTMLElement;
  copy.removeAttribute("data-task-card");
  Object.assign(copy.style, {
    position: "absolute",
    left: "0",
    top: "0",
    margin: "0",
    width: `${card.offsetWidth}px`,
  });
  layer.append(copy);
  card.style.visibility = "hidden";
  const flight = copy.animate(
    { transform: [`translate(${from.x}px, ${from.y}px)`, `translate(${to.x}px, ${to.y}px)`] },
    { duration: 460, easing: EASE },
  );
  void flight.finished
    .catch(() => {})
    .finally(() => {
      copy.remove();
      card.style.visibility = "";
      // The ring says what just changed, and still does when the flight was off screen.
      card.animate(
        {
          boxShadow: [
            "0 0 0 2px var(--column-color), 0 0 14px var(--column-color)",
            "0 0 0 0 transparent",
          ],
        },
        { duration: 900, easing: "ease-out" },
      );
    });
}

/**
 * Moves the board's cards between where they were and where they are after a commit: a card that
 * changed column flies there, one that is new settles in, and the rest close up or make room.
 *
 * Plain DOM and not framer's `layout`: a column's overflow clips a card leaving it, and dnd-kit
 * owns the transform of a card being dragged. A drag moves cards itself, so nothing here runs
 * during one or while its drop lands. The column is read from the DOM rather than the task, which
 * means a dropped card, already drawn in its new column, is not flown there when the server agrees.
 *
 * ponytail: a project's very first card does not settle in, because an empty list looks the same as
 * one still loading. Pass the query's loaded state in if that ever matters.
 */
export function useCardMotion(
  rootRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  projectId: number | null,
  dragging: boolean,
) {
  const spots = useRef(new Map<number, CardSpot>());
  const seen = useRef(new Set<number>());
  const project = useRef<number | null>(null);
  const settleUntil = useRef(0);

  useEffect(() => {
    if (!dragging) settleUntil.current = performance.now() + DROP_SETTLE_MS;
  }, [dragging]);

  // No dependencies: every commit can have moved a card, and this reads only offsets.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const layer = layerRef.current;
    if (!root || !layer) return;
    const quiet =
      dragging ||
      performance.now() < settleUntil.current ||
      document.documentElement.classList.contains("reduce-motion") ||
      projectId === null ||
      projectId !== project.current;
    if (projectId !== null && projectId !== project.current) {
      project.current = projectId;
      seen.current.clear();
    }

    const next = new Map<number, CardSpot>();
    for (const card of root.querySelectorAll<HTMLElement>("[data-task-card]")) {
      const column = card.closest<HTMLElement>("[data-column-scroll]")?.dataset.columnScroll;
      if (!column) continue;
      const id = Number(card.dataset.taskCard);
      const now = { column, x: card.offsetLeft, y: card.offsetTop };
      next.set(id, now);
      const prev = spots.current.get(id);
      if (!quiet) {
        const move = cardMove(prev, seen.current.has(id), now);
        if (move === "fly") fly(root, layer, card, prev!, now);
        if (move === "enter") {
          card.animate(
            { opacity: [0, 1], transform: ["scale(0.96) translateY(-6px)", "none"] },
            { duration: 320, delay: 80, easing: EASE, fill: "backwards" },
          );
        }
        if (move === "reflow") {
          card.animate(
            { transform: [`translateY(${prev!.y - now.y}px)`, "none"] },
            { duration: 280, easing: EASE },
          );
        }
      }
      seen.current.add(id);
    }
    spots.current = next;
  });
}
