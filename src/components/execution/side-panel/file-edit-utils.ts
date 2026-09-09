/**
 * The decisions the Files tab's edit mode has to make, kept out of the component so they can be
 * tested without a webview. They are all small, and they are the places a mistake silently
 * destroys someone's work.
 */

/** How often the open file is re-read, in ms, or `false` to stop polling. */
export const FILE_POLL_INTERVAL_MS = 3000;

/**
 * The Files tab re-reads the open file every few seconds because an agent is usually writing into
 * the same worktree. That cannot continue in edit mode: a refetch would swap the content out from
 * under the buffer the user is typing into. Suspending it is what opens the window that
 * [`decideSave`] closes at save time — the two are a pair, and changing one without the other
 * either clobbers the user's typing or clobbers the agent's file.
 *
 * A query that has already errored stays stopped, so an unreadable path is not retried forever.
 */
export function filePollInterval({
  hasError,
  isActive,
  mode,
}: {
  hasError: boolean;
  isActive: boolean;
  mode: "view" | "edit";
}): number | false {
  if (hasError) return false;
  return isActive && mode === "view" ? FILE_POLL_INTERVAL_MS : false;
}

export type SaveDecision =
  /** The file on disk still matches what edit mode opened with — safe to replace. */
  | { kind: "write" }
  /** Something else wrote the file since edit mode opened. Ask before replacing it. */
  | { kind: "conflict" }
  /** The draft already matches disk. Nothing to write; just re-baseline. */
  | { kind: "unchanged" };

/**
 * `baseline` is the text captured when edit mode opened, `onDisk` what a read returns immediately
 * before writing. Comparing text rather than mtime is deliberate: mtime granularity and clock skew
 * differ across the local, SSH, WSL and container paths, and a false "unchanged" there overwrites
 * the agent's work.
 *
 * The draft-equals-disk case is checked first so that an agent writing exactly what the user typed
 * is not reported as a conflict.
 */
export function decideSave({
  baseline,
  draft,
  onDisk,
}: {
  baseline: string;
  draft: string;
  onDisk: string;
}): SaveDecision {
  if (draft === onDisk) return { kind: "unchanged" };
  if (onDisk !== baseline) return { kind: "conflict" };
  return { kind: "write" };
}

/**
 * Whether the pencil button should be offered at all. Everything the read view renders through a
 * mime branch — images, PDF, audio, video — and everything it refused to load is not editable
 * text, and offering an editor for it would open an empty buffer that a save would then write over
 * the real file.
 */
export function canEditFile({
  fileName,
  binaryMime,
  error,
  content,
}: {
  fileName: string | null;
  binaryMime: string | undefined;
  error: unknown;
  content: string | null | undefined;
}): boolean {
  return fileName != null && binaryMime == null && error == null && content != null;
}

/** How the Files tab arranges an open markdown file in edit mode. */
export type MarkdownEditLayout = "source" | "split" | "preview";

const MARKDOWN_EDIT_LAYOUTS: readonly MarkdownEditLayout[] = ["source", "split", "preview"];

/**
 * Read the stored layout preference, defaulting to `source`.
 *
 * The setting is a free-text column shared with every other preference, so an absent, blank or
 * unrecognised value has to resolve to something usable rather than blanking the editor — the same
 * fallback shape `log_level` uses.
 */
export function parseMarkdownEditLayout(value: string | null | undefined): MarkdownEditLayout {
  return MARKDOWN_EDIT_LAYOUTS.includes(value as MarkdownEditLayout)
    ? (value as MarkdownEditLayout)
    : "source";
}

/**
 * Narrowest a single pane may get in the split view before the layout collapses to one pane.
 *
 * Measured rather than guessed: below roughly this, wrapped prose and a code block side by side
 * stop being readable, so a ~1000px edit area is the point where split earns its place. The side
 * panel is `max-w-[50%]` of the window, so on most screens split only appears once the panel is
 * maximized — which is the honest answer rather than showing two unusable columns.
 */
export const MIN_SPLIT_PANE_PX = 500;

/**
 * The layout actually rendered, which is not always the one stored.
 *
 * Non-markdown has nothing to preview, and a pane too narrow to read is worse than one pane. The
 * stored preference is left untouched in both cases, so widening the panel restores split without
 * the user having to ask for it again.
 *
 * `availableWidth` is `null` before the first measurement, and **zero means not laid out** — an
 * inactive side-panel tab is `hidden`, so it measures 0 while carrying a perfectly wide layout.
 * Both are treated as "assume it fits", so a user who chose split never sees a frame of source
 * view when the tab is first shown.
 */
export function resolveMarkdownLayout({
  layout,
  isMarkdown,
  availableWidth,
}: {
  layout: MarkdownEditLayout;
  isMarkdown: boolean;
  availableWidth: number | null;
}): MarkdownEditLayout {
  if (!isMarkdown) return "source";
  if (layout !== "split") return layout;
  const measured = availableWidth !== null && availableWidth > 0;
  if (measured && availableWidth < MIN_SPLIT_PANE_PX * 2) return "source";
  return "split";
}

/**
 * Where to put the other pane's scroll position, as a share of the distance each can travel.
 *
 * This is proportional sync, not line-anchored: both panes reach the top and the bottom together
 * and interpolate linearly in between. It is exact for prose, where rendered height tracks source
 * height, and drifts wherever it does not — a one-line image tag that renders 400px tall, or a
 * long code block that renders more compactly than its source. Aligning those needs source-line
 * anchors on the rendered blocks, which is a change to the shared markdown renderer.
 *
 * A pane with nothing to scroll yields 0 rather than `NaN`, which would wipe out the position.
 */
export function proportionalScrollTop({
  scrollTop,
  scrollHeight,
  clientHeight,
  targetScrollHeight,
  targetClientHeight,
}: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  targetScrollHeight: number;
  targetClientHeight: number;
}): number {
  const travel = scrollHeight - clientHeight;
  const targetTravel = targetScrollHeight - targetClientHeight;
  if (travel <= 0 || targetTravel <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, scrollTop / travel));
  return ratio * targetTravel;
}

/**
 * How a create destination is named in the tree's tooltips and the create dialog.
 *
 * "New file" used to give no clue where the file would land — the header button always meant the
 * workspace root and nothing said so. The destination is now always spelled out, relative to the
 * workspace so it matches what the tree shows rather than an absolute path nobody recognises.
 */
export function folderLabel(absolutePath: string, workspacePath: string): string {
  if (absolutePath === workspacePath) return "the workspace root";
  const prefix = `${workspacePath}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

/** Characters no entry name may contain on any platform we browse, plus the path separators. */
const ILLEGAL_NAME = /[/\\:*?"<>|]/;

/**
 * Validate a name typed into the create/rename dialog, returning the message to show or `null`
 * when it is usable. `siblings` comes from the directory listing the tree already has cached, so
 * this catches the common collision before the round trip — the backend refuses collisions too,
 * which is what actually makes it safe.
 */
export function validateEntryName(name: string, siblings: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name cannot be empty";
  if (trimmed === "." || trimmed === "..") return "Name cannot be “.” or “..”";
  if (ILLEGAL_NAME.test(trimmed)) return 'Name cannot contain / \\ : * ? " < > or |';
  if (siblings.includes(trimmed)) return `“${trimmed}” already exists here`;
  return null;
}
