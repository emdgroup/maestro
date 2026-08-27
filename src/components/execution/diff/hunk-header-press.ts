/**
 * The cell `@git-diff-view` puts its expand arrows in, on a chunk-header row.
 *
 * Both the unified and split views mark the row `data-state="hunk"` and give that first cell the
 * `diff-line-hunk-action` class, in both their normal and wrapped variants, so this one selector
 * covers all four. Neither name is a documented API — `hunk_header_press.test.tsx` renders a real
 * diff and asserts this matches, so a dependency bump that renames them fails a test rather than
 * silently removing the button.
 */
export const HUNK_ACTION_SELECTOR = 'tr[data-state="hunk"] td.diff-line-hunk-action';

/** Marks a diff whose chunk headers are a request for context rather than expand controls. */
export const CONTEXT_REQUEST_CLASS = "diff-context-request";

/**
 * Call `onPress` when the user clicks a chunk header's action cell.
 *
 * Delegated from the wrapper rather than rendered into the cell because the cell is the library's
 * own DOM: when expansion is disabled it renders a blank spacer there and offers no way to put
 * anything inside it. The affordance itself is drawn by CSS keyed on {@link CONTEXT_REQUEST_CLASS}.
 *
 * Returns a cleanup function, so this is written to be used as a ref callback — an effect keyed on
 * the enabling props would run once against nothing, since the wrapper is not rendered until the
 * highlighter has loaded. That is the same reason `bindWidgetPressFlag` in `DiffViewer` is one.
 */
export function bindHunkHeaderPress(
  wrapper: HTMLElement | null,
  onPress: (() => void) | undefined,
): (() => void) | undefined {
  if (!wrapper || !onPress) return;
  const handle = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(HUNK_ACTION_SELECTOR)) return;
    // The header row is also a multi-select surface; without this a press meant for the button
    // starts a drag selection underneath it.
    event.stopPropagation();
    event.preventDefault();
    onPress();
  };
  wrapper.addEventListener("click", handle);
  return () => wrapper.removeEventListener("click", handle);
}
