import { morph } from "@/components/layout/project-transition/projectTransition";

/** The name a card and the task dialog share, so the browser morphs one into the other. */
const ZOOM = "task-zoom";

const dialog = () => document.querySelector<HTMLElement>("[data-task-dialog]");
const overlay = () => document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');

/** The dialog's own fade would be caught on its first frame, so the morph would end on nothing. */
function finishEntrance(el: HTMLElement | null) {
  for (const animation of el?.getAnimations() ?? []) animation.finish();
}

/**
 * The dialog mounts a little after the state that opens it. Polled with a timer and not a frame:
 * the browser draws nothing while a view transition's callback is pending.
 */
async function whenDialogMounted(): Promise<HTMLElement | null> {
  for (let i = 0; i < 10; i++) {
    const el = dialog();
    if (el) return el;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

/** Grow the task dialog out of the card that was clicked. `open` shows the dialog. */
export function zoomCardToDialog(card: HTMLElement, open: () => void) {
  card.style.viewTransitionName = ZOOM;
  let target: HTMLElement | null = null;
  const transition = morph(
    () => {
      card.style.viewTransitionName = "";
      open();
    },
    async () => {
      target = await whenDialogMounted();
      if (target) target.style.viewTransitionName = ZOOM;
      finishEntrance(target);
      finishEntrance(overlay());
    },
  );
  // A name left behind would pair the dialog with the next card as well.
  void transition?.finished.finally(() => {
    if (target) target.style.viewTransitionName = "";
  });
}

/**
 * Shrink the task dialog back into its card. `close` hides the dialog. With no card to land on, as
 * when the task was opened from the archive, the dialog just closes as any other does.
 */
export function zoomDialogToCard(taskId: number, close: () => void) {
  const from = dialog();
  const card = document.querySelector<HTMLElement>(`[data-task-card="${taskId}"]`);
  if (!from || !card) {
    close();
    return;
  }
  from.style.viewTransitionName = ZOOM;
  const scrim = overlay();
  const transition = morph(() => {
    from.style.viewTransitionName = "";
    close();
    // Its exit animation would be in the picture the card morphs towards.
    from.style.visibility = "hidden";
    if (scrim) scrim.style.visibility = "hidden";
    card.style.viewTransitionName = ZOOM;
  });
  void transition?.finished.finally(() => {
    card.style.viewTransitionName = "";
  });
}
