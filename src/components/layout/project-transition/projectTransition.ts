import { create } from "zustand";
import type { useAnimationControls } from "framer-motion";
import type { Project } from "@/types/bindings";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { connectionKeyId } from "@/store/homeStore";
import { PAGE_TRANSITION_DURATION, PAGE_TRANSITION_EASING } from "@/utils/constants/animations";

/**
 * The two ways the window changes project, see "Navigation into a project" in
 * docs/home-dashboard/design.md: from Home a card grows out of the project's tile and back into
 * it, and between projects the view slides up or down by the projects' order in the header's menus.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Zoom =
  | { kind: "open"; from: Box | null; grown: () => void }
  | { kind: "close"; to: () => Box | null };

export const useZoomStore = create<{ zoom: Zoom | null }>(() => ({ zoom: null }));

/** Grow a card from `from`, or the middle of the window, until it covers the window. */
export function growIntoProject(from: Box | null): Promise<void> {
  return new Promise((grown) => useZoomStore.setState({ zoom: { kind: "open", from, grown } }));
}

/** Cover the window now, then shrink into `to` once Home has drawn the tile it asks for. */
export function shrinkToHome(to: () => Box | null) {
  useZoomStore.setState({ zoom: { kind: "close", to } });
}

/** Where the project's tile, or its chip on a minimized panel, sits on Home. */
export function tileBox(project: Project): Box | null {
  const connection = connectionKeyId(connectionKeyFromProject(project));
  const panel = document.querySelector(`[data-home-connection="${CSS.escape(connection)}"]`);
  const tile = panel?.querySelector(`[data-home-project="${CSS.escape(project.path)}"]`);
  if (!tile) return null;
  const { left, top, width, height } = tile.getBoundingClientRect();
  return { left, top, width, height };
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
