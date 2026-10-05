import { flushSync } from "react-dom";
import type { useAnimationControls } from "framer-motion";
import type { Project } from "@/types/bindings";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { connectionKeyId } from "@/store/homeStore";
import { PAGE_TRANSITION_DURATION, PAGE_TRANSITION_EASING } from "@/utils/constants/animations";

/**
 * The two ways the window changes project, see "Navigation into a project" in
 * docs/home-dashboard/design.md: from Home the project grows out of its tile and back into it, and
 * between projects the view slides up or down by the projects' order in the header's menus.
 */

/** The name the tile and the project's window share, so the browser morphs one into the other. */
const ZOOM = "project-zoom";

/** The project's tile on Home, or its chip on a minimized panel. */
function tileOf(project: Project): HTMLElement | null {
  const connection = connectionKeyId(connectionKeyFromProject(project));
  const panel = document.querySelector(`[data-home-connection="${CSS.escape(connection)}"]`);
  return (
    panel?.querySelector<HTMLElement>(`[data-home-project="${CSS.escape(project.path)}"]`) ?? null
  );
}

/**
 * Run `update` as a view transition: the browser snapshots the window before and after and
 * animates between them, the project's tile and window morphing into each other. Without the API
 * (an older WebKitGTK) or with Reduce motion on, the switch is immediate.
 */
function morph(update: () => void): ViewTransition | null {
  if (
    !document.startViewTransition ||
    document.documentElement.classList.contains("reduce-motion")
  ) {
    update();
    return null;
  }
  return document.startViewTransition(() => flushSync(update));
}

/** Open the project out of its tile. `show` switches the window to it. */
export function zoomIntoProject(project: Project, show: () => void) {
  const tile = tileOf(project);
  if (tile) tile.style.viewTransitionName = ZOOM;
  const transition = morph(() => {
    if (tile) tile.style.viewTransitionName = "";
    show();
  });
  return transition?.updateCallbackDone ?? Promise.resolve();
}

/** Go back to Home, the project shrinking into its tile. `leave` switches the window to Home. */
export function zoomToHome(project: Project, leave: () => void) {
  let tile: HTMLElement | null = null;
  const transition = morph(() => {
    leave();
    // Home is drawn by now, from the summaries it already holds.
    tile = tileOf(project);
    if (!tile) return;
    tile.style.viewTransitionName = ZOOM;
    // The tiles fade in when their panel appears, and the browser takes its picture of Home on
    // the first frame of that fade, so the project would shrink into an invisible tile. Finish the
    // entrance now; the endless ones (a Working label's pulse) cannot be finished and need not be.
    const panel = tile.closest("[data-home-connection]");
    for (const animation of panel?.getAnimations({ subtree: true }) ?? []) {
      if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
    }
  });
  // A name left behind would pair the tile with the project again on the next open.
  void transition?.finished.finally(() => {
    if (tile) tile.style.viewTransitionName = "";
  });
}

type Controls = ReturnType<typeof useAnimationControls>;
const transition = { duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING } as const;

let main: Controls | null = null;
let slide: { direction: 1 | -1; out: Promise<unknown> } | null = null;

/** The project's views, which slide when the window switches project. */
export function registerProjectMain(controls: Controls) {
  main = controls;
  return () => {
    if (main === controls) main = null;
  };
}

/** Slide the current project out: up when the next one is further down the list, down if not. */
export function slideOut(direction: 1 | -1) {
  const out =
    main?.start({ y: `${-100 * direction}%`, opacity: 0, transition }) ?? Promise.resolve();
  slide = { direction, out };
}

/** Resolves once the current project has left, so the switch never cuts it off halfway. */
export function whenSlidOut(): Promise<unknown> {
  return slide?.out ?? Promise.resolve();
}

/** Bring the new project in from the side the old one left towards. */
export function slideIn() {
  if (!slide || !main) return;
  const { direction } = slide;
  slide = null;
  main.set({ y: `${100 * direction}%`, opacity: 0 });
  void main.start({ y: 0, opacity: 1, transition });
}

/** The switch did not happen (refused, failed, a takeover asked for): bring the old one back. */
export function slideBack() {
  if (!slide || !main) return;
  slide = null;
  void main.start({ y: 0, opacity: 1, transition });
}
