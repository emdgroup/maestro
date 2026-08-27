import { describe, it, expect, vi } from "vitest";
import { bindHunkHeaderPress, HUNK_ACTION_SELECTOR } from "./hunk-header-press";

/**
 * `HUNK_ACTION_SELECTOR` names classes and attributes that belong to `@git-diff-view`, not to us.
 * The markup below is copied from its `DiffUnifiedHunkLine` / `DiffSplitHunkLine*` components — if
 * a dependency bump renames either, this fails here rather than silently leaving the chunk headers
 * unclickable in a build nobody re-checks by hand.
 */
function hunkRow(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <table><tbody>
      <tr data-line="1-content" data-state="content">
        <td class="diff-line-num">1</td>
        <td class="diff-line-content">unchanged</td>
      </tr>
      <tr data-line="2-hunk" data-state="hunk" class="diff-line diff-line-hunk">
        <td class="diff-line-hunk-action sticky left-0"><div class="min-h-[28px]">&ensp;</div></td>
        <td class="diff-line-hunk-content">@@ -17,7 +17,7 @@</td>
      </tr>
    </tbody></table>
  `;
  document.body.appendChild(wrapper);
  return wrapper;
}

function clickIn(wrapper: HTMLElement, selector: string) {
  const target = wrapper.querySelector(selector);
  expect(target, `nothing matched ${selector}`).not.toBeNull();
  target!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("bindHunkHeaderPress", () => {
  it("matches the action cell in the library's own chunk-header markup", () => {
    expect(hunkRow().querySelector(HUNK_ACTION_SELECTOR)).not.toBeNull();
  });

  it("fires when the action cell is pressed", () => {
    const wrapper = hunkRow();
    const onPress = vi.fn();
    bindHunkHeaderPress(wrapper, onPress);

    clickIn(wrapper, HUNK_ACTION_SELECTOR);
    expect(onPress).toHaveBeenCalledOnce();
  });

  // The spacer div is what the library renders inside the cell while expansion is off, so the
  // press almost always lands on it rather than on the cell itself.
  it("fires when a child of the action cell is pressed", () => {
    const wrapper = hunkRow();
    const onPress = vi.fn();
    bindHunkHeaderPress(wrapper, onPress);

    clickIn(wrapper, `${HUNK_ACTION_SELECTOR} div`);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("ignores presses on the hunk text and on ordinary diff lines", () => {
    const wrapper = hunkRow();
    const onPress = vi.fn();
    bindHunkHeaderPress(wrapper, onPress);

    clickIn(wrapper, ".diff-line-hunk-content");
    clickIn(wrapper, ".diff-line-content");
    expect(onPress).not.toHaveBeenCalled();
  });

  // Withholding the callback is how a file with no fetchable pre-image leaves its headers inert.
  it("binds nothing without a handler", () => {
    const wrapper = hunkRow();
    expect(bindHunkHeaderPress(wrapper, undefined)).toBeUndefined();
  });

  it("stops listening once cleaned up", () => {
    const wrapper = hunkRow();
    const onPress = vi.fn();
    const cleanup = bindHunkHeaderPress(wrapper, onPress);

    cleanup?.();
    clickIn(wrapper, HUNK_ACTION_SELECTOR);
    expect(onPress).not.toHaveBeenCalled();
  });
});
