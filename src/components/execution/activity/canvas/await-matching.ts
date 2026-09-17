/**
 * Which pending `canvas_await` a surface's controls answer.
 *
 * The user can page between every canvas the agent has drawn, so "the awaited surface" is not a
 * single thing: several waits can be open, and a wait that named no surface takes whichever one
 * the user acts on. Both rules live here rather than in the panel because the panel cannot be
 * tested and this is the part that can be got wrong.
 */
export interface PendingCanvasAwait {
  requestId: string;
  /** `null` when the agent called `canvas_await` without a `surfaceId` — any surface answers it. */
  surfaceId: string | null;
}

/**
 * The wait a click on `surfaceId` should resolve, or `null` if the surface is not live.
 *
 * A wait naming the surface wins over one that takes any surface, so an agent that asks about a
 * specific canvas is answered by that canvas even while a catch-all wait is open. Newest first
 * within each group: a re-asked question supersedes the one it repeats.
 */
export function awaitForSurface(
  pending: readonly PendingCanvasAwait[],
  surfaceId: string | null | undefined,
): PendingCanvasAwait | null {
  if (surfaceId == null) return null;
  return (
    findLast(pending, (entry) => entry.surfaceId === surfaceId) ??
    findLast(pending, (entry) => entry.surfaceId == null)
  );
}

/**
 * The wait the panel should page to, or `null` to leave the user where they are.
 *
 * Only a wait that names a surface has somewhere to page to; a catch-all wait is answerable from
 * the canvas already on screen, so moving the user would be taking the page away from them.
 */
export function awaitToFollow(pending: readonly PendingCanvasAwait[]): PendingCanvasAwait | null {
  return findLast(pending, (entry) => entry.surfaceId != null);
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return null;
}
