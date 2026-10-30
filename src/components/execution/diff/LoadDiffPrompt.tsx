/**
 * What a file too large to render on sight shows instead of its diff.
 *
 * An explicit button rather than something triggered by scrolling. Building a diff is tens of
 * milliseconds of blocked main thread, and doing that while the user is scrolling is what makes a
 * stack feel bad — the work competes with the scroll every frame. A press is a moment the user
 * already expects to wait for, so the same cost reads as an answer rather than as jank.
 */
export function LoadDiffPrompt({ lines, onLoad }: { lines: number; onLoad: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8">
      {/* The size, which is the only reason a file ends up here. Zero means there is nothing to
          count — an untracked file whose body has not been fetched yet. */}
      {lines > 0 && <p className="text-xs text-muted-foreground">{lines.toLocaleString()} lines</p>}
      <button type="button" onClick={onLoad} className="home-pane text-xs px-3 py-1.5 rounded-xl">
        Load diff
      </button>
    </div>
  );
}
