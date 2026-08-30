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
      {/* The size, and nothing about why. A file can end up here because it is large or because
          the review ran out of budget before reaching it, and an explanation naming one reason
          would be wrong half the time. Zero means there is nothing to count — an untracked file
          whose body has not been fetched yet. */}
      {lines > 0 && <p className="text-xs text-muted-foreground">{lines.toLocaleString()} lines</p>}
      <button
        type="button"
        onClick={onLoad}
        className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-muted/40 transition-colors"
      >
        Load diff
      </button>
    </div>
  );
}
