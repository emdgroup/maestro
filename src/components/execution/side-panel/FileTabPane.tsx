import { useEffect, useRef } from "react";
import { SegmentThumb } from "@/components/common/SegmentThumb";
import { Eye, FilePen, Save, X, Code, Columns2, Link2, Unlink2, TriangleAlert } from "lucide-react";
import { SEGMENT_GROUP } from "@/lib/segmented";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { useConnectionFileQuery } from "@/services/connection.service";
import { binaryMimeForExtension } from "@/components/execution/activity/fileTypeUtils";
import type { ConnectionKey } from "@/types/bindings";
import { WorkspaceFileContent } from "./WorkspaceFileContent";
import { FileEditor } from "./FileEditor";
import {
  canEditFile,
  filePollInterval,
  previewKindFor,
  type MarkdownEditLayout,
} from "./file-edit-utils";
import { useFileDraft } from "./useFileDraft";
import { useMarkdownLayout } from "./useMarkdownLayout";
import { ToolbarButton } from "./ToolbarButton";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/ui/resizable";
import { basename, type LineRange } from "@/lib/path-utils";
import { FileHeaderActions } from "./FileHeaderActions";

/** The three markdown arrangements, as a segmented group among the file's floating actions. */
const MARKDOWN_LAYOUTS: ReadonlyArray<{
  value: MarkdownEditLayout;
  Icon: typeof Code;
  label: string;
}> = [
  { value: "source", Icon: Code, label: "Source only" },
  { value: "split", Icon: Columns2, label: "Source and preview" },
  { value: "preview", Icon: Eye, label: "Preview only" },
];

interface FileTabPaneProps {
  /** Relative to the workspace, or absolute for a file outside it. */
  path: string;
  /** Absolute; `path` resolved against the workspace. */
  fullPath: string;
  connection: ConnectionKey;
  wslDistroName?: string;
  /** On screen: the panel is visible and this is its side's open tab. Drives polling. */
  isActive: boolean;
  /** Drives the warning shown on entering edit mode: the agent may be writing this file. */
  isProcessing: boolean;
  revealLines?: LineRange;
  revealKey?: number;
  onDirtyChange: (dirty: boolean) => void;
  /** Closing this tab is waiting on what to do with its unsaved draft. */
  confirmClose: boolean;
  /** Answers `confirmClose`: whether the tab may close now. */
  onCloseResolved: (close: boolean) => void;
  /** Which side of the panel shows it, for the panel to tell where a press landed. */
  side: number;
  /** Places the pane: it is the well its side shows, so the side's look is passed in. */
  className?: string;
  style?: React.CSSProperties;
}

/**
 * One open file: what is on disk, the draft while editing, and the actions that act on either.
 *
 * Every open tab keeps its pane mounted, hidden when another tab is showing, which is what keeps
 * a draft and a scroll position across tab switches. The actions float over the file's top-right
 * corner rather than taking a header row; `.file-float` in `index.css` keeps them out of the way
 * until the pointer is over the file.
 */
export function FileTabPane({
  path,
  fullPath,
  connection,
  wslDistroName,
  isActive,
  isProcessing,
  revealLines,
  revealKey,
  onDirtyChange,
  confirmClose,
  onCloseResolved,
  side,
  className,
  style,
}: FileTabPaneProps) {
  const fileDir = fullPath.replace(/\/[^/]+$/, "");
  const binaryMime = binaryMimeForExtension(path);

  // Above the read query, which reads `mode` from its poll interval.
  const {
    mode,
    draft,
    setDraft,
    docEpoch,
    saveError,
    conflict,
    setConflict,
    saving,
    isDirty,
    discardPrompt,
    setDiscardPrompt,
    discardDraft,
    enterEdit,
    leaveEdit,
    handleSave,
    handleOverwrite,
    handleReloadFromDisk,
  } = useFileDraft({ connection, fullPath, onDirtyChange });

  const {
    data: content,
    isLoading: contentLoading,
    error: contentError,
    refetch,
  } = useConnectionFileQuery(connection, binaryMime ? null : fullPath, false, {
    refetchInterval: (query) =>
      filePollInterval({ hasError: query.state.error != null, isActive, mode }),
  });
  const {
    data: binaryContent,
    isLoading: binaryLoading,
    error: binaryError,
  } = useConnectionFileQuery(connection, binaryMime ? fullPath : null, true);

  useEffect(() => {
    if (isActive && !binaryMime && mode === "view") {
      void refetch();
    }
  }, [isActive, binaryMime, mode, refetch]);

  const fileName = basename(path);
  const editable = canEditFile({ fileName: path, binaryMime, error: contentError, content });
  const previewKind = previewKindFor(path);

  // Markdown, HTML, images, PDFs and load errors keep their own renderers; plain text is the
  // editor in both modes. Keeping the same element type across the mode toggle is what stops React
  // remounting it — and with it the scroll position.
  const showsEditorSurface = mode === "edit" || (editable && previewKind === null);

  const {
    chooseLayout,
    effectiveLayout,
    splitFits,
    scrollSync,
    chooseScrollSync,
    editAreaRef,
    setEditorScroller,
    setPreviewScroller,
  } = useMarkdownLayout({ hasPreview: previewKind !== null, showsEditorSurface });

  // One editor for both modes, so read and edit cannot disagree about colour and the toggle keeps
  // the scroll position. In view mode it follows what was read from disk; in edit mode it owns the
  // draft and reports it back.
  const editor = (
    <FileEditor
      doc={mode === "edit" ? draft : (content ?? "")}
      docEpoch={docEpoch}
      fileName={path}
      readOnly={mode === "view"}
      onChange={setDraft}
      onSave={() => void handleSave()}
      onScrollerChange={setEditorScroller}
      revealLines={revealLines}
      revealKey={revealKey}
    />
  );

  // The draft, not the file — previewing what is on disk while editing something else would be
  // worse than no preview at all.
  const draftPreview = (
    <WorkspaceFileContent
      content={draft}
      isLoading={false}
      error={null}
      fileName={path}
      fileDir={fileDir}
      scrollRef={setPreviewScroller}
    />
  );

  const body = showsEditorSurface ? (
    <div ref={editAreaRef} data-slot="markdown-edit-area" className="flex-1 flex flex-col min-h-0">
      {mode === "edit" && (
        <EditNotices isDirty={isDirty} isProcessing={isProcessing} saveError={saveError} />
      )}
      <EditSurface layout={effectiveLayout} editor={editor} preview={draftPreview} />
    </div>
  ) : (
    <WorkspaceFileContent
      content={binaryMime ? (binaryContent ?? null) : (content ?? null)}
      isLoading={binaryMime ? binaryLoading : contentLoading}
      error={loadErrorText(binaryMime ? binaryError : contentError)}
      fileName={path}
      mimeType={binaryMime}
      fileDir={fileDir}
    />
  );

  const inEdit = mode === "edit";
  const saveDisabled = saving || !isDirty;
  const showLayoutGroup = inEdit && previewKind !== null;
  // Markdown only: the HTML preview is a cross-origin iframe, whose scroll position the parent
  // cannot read without `allow-same-origin` — which is the one thing the sandbox is there for.
  const showSyncToggle = inEdit && effectiveLayout === "split" && previewKind === "markdown";
  const syncLabel = scrollSync ? "Turn off synced scrolling" : "Turn on synced scrolling";

  // Leaving the editor takes the focus out of it, since it stops being editable; the file keeps
  // it, so its keys (Ctrl+E again, Ctrl+O) go on working without a click. The dialogs that ask
  // first hand it back the same way, through `finalFocus`.
  const paneRef = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    const left = wasEditing.current && !inEdit;
    wasEditing.current = inEdit;
    const pane = paneRef.current;
    const focus = document.activeElement;
    if (left && pane && (focus === document.body || pane.contains(focus))) {
      pane.focus({ preventScroll: true });
    }
  }, [inEdit]);

  /** Back to reading; `leaveEdit` asks first when the draft is unsaved. */
  function leave() {
    // Refetched only when it actually left: reading over an undecided edit would be worse than
    // stale.
    if (leaveEdit()) void refetch();
  }

  return (
    <div
      ref={paneRef}
      data-side={side}
      // Focusable, and focused by a press anywhere in it, so the file's keys come here. CodeMirror
      // takes a press for itself and, read-only, focuses nothing, which left them on the page.
      tabIndex={-1}
      onMouseDown={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) {
          e.currentTarget.focus({ preventScroll: true });
        }
      }}
      onKeyDown={(e) => {
        // A dialog's keys reach here through its portal, and the editor's own Escape (closing its
        // search, say) arrives already handled: neither is ours.
        if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        // Ctrl+C stays the editor's copy; Esc is the way out of editing.
        if (e.key === "Escape" && inEdit) {
          // Stopped here: the discard prompt this may open listens for Escape on the document, and
          // would close on the same key press.
          e.preventDefault();
          e.stopPropagation();
          leave();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
          e.preventDefault();
          if (!inEdit && editable) enterEdit(content);
        }
      }}
      className={cn("file-pane relative flex flex-col min-h-0 min-w-0 outline-none", className)}
      style={style}
    >
      {body}

      <div className="file-float absolute top-2 right-3.5 z-10 flex flex-wrap justify-end items-center gap-1 max-w-[calc(100%-1.75rem)]">
        {inEdit ? (
          // The pairing that confused people was a floppy disk beside a tick: the tick reads as
          // "confirm", which is the opposite of what it does on a dirty buffer. An X always means
          // "leave", and its tooltip is what says whether leaving will cost anything.
          <>
            {/* Only in split: with one pane there is nothing to keep in step, and a toggle that does
                nothing is worse than no toggle. It sits beside what it modifies. */}
            {showSyncToggle && (
              <ToolbarButton
                label={syncLabel}
                tooltip={
                  scrollSync
                    ? "The panes scroll together — click to unlink"
                    : "The panes scroll independently — click to link"
                }
                active={scrollSync}
                onClick={() => chooseScrollSync(!scrollSync)}
              >
                {scrollSync ? <Link2 className="size-3.5" /> : <Unlink2 className="size-3.5" />}
              </ToolbarButton>
            )}
            {showLayoutGroup && (
              <LayoutToggle
                layout={effectiveLayout}
                onChoose={chooseLayout}
                splitFits={splitFits}
              />
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Save"
                    onClick={() => void handleSave()}
                    disabled={saveDisabled}
                    // The accent is what says "there is unsaved work here". Wearing it with nothing
                    // to save promised an action the button would not perform.
                    className={cn("home-pane rounded-xl", !saveDisabled && "text-accent")}
                  />
                }
              >
                {saving ? <Spinner className="size-3.5" /> : <Save className="size-3.5" />}
              </TooltipTrigger>
              <TooltipContent>Save (Ctrl+S)</TooltipContent>
            </Tooltip>
            {/* One icon, two meanings, and the tooltip is what separates them. `leaveEdit` raises
                the discard prompt itself when there is something to discard. */}
            <ToolbarButton
              label={isDirty ? "Discard" : "Close"}
              tooltip={isDirty ? "Discard unsaved changes (Esc)" : "Close the editor (Esc)"}
              disabled={saving}
              onClick={leave}
            >
              <X className="size-3.5" />
            </ToolbarButton>
          </>
        ) : (
          <>
            {editable && (
              <ToolbarButton
                label="Edit"
                tooltip="Edit this file (Ctrl+E)"
                onClick={() => enterEdit(content)}
              >
                <FilePen className="size-3.5" />
              </ToolbarButton>
            )}
            <FileHeaderActions
              connection={connection}
              path={fullPath}
              wslDistroName={wslDistroName}
            />
          </>
        )}
      </div>

      <PaneDialog
        open={conflict !== null}
        onDismiss={() => setConflict(null)}
        title="This file changed while you were editing"
        returnFocus={paneRef}
        description={`${fileName} was written by something else — most likely the agent — since you started editing. Overwriting replaces those changes with yours; reloading discards yours.`}
      >
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          onClick={() => conflict && handleReloadFromDisk(conflict.onDisk)}
        >
          Reload, discarding mine
        </AlertDialogAction>
        <AlertDialogAction variant="destructive" onClick={() => void handleOverwrite()}>
          Overwrite
        </AlertDialogAction>
      </PaneDialog>

      <PaneDialog
        open={discardPrompt}
        onDismiss={() => setDiscardPrompt(false)}
        title="Discard unsaved changes?"
        returnFocus={paneRef}
        description={`${fileName} has edits that have not been written to disk. They will be lost.`}
      >
        <AlertDialogCancel>Keep editing</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={discardDraft}>
          Discard
        </AlertDialogAction>
      </PaneDialog>

      <PaneDialog
        open={confirmClose}
        onDismiss={() => onCloseResolved(false)}
        title={`Save changes to ${fileName}?`}
        returnFocus={paneRef}
        description="Closing the tab loses the edits that have not been written to disk."
      >
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={() => onCloseResolved(true)}>
          Discard
        </AlertDialogAction>
        <AlertDialogAction
          // A conflict or a failed write keeps the tab open, with the reason on screen.
          onClick={() => void handleSave().then((saved) => onCloseResolved(saved))}
        >
          Save
        </AlertDialogAction>
      </PaneDialog>
    </div>
  );
}

function loadErrorText(error: unknown): string | null {
  return error ? String(error) : null;
}

const NOTICE =
  "flex items-center gap-1.5 px-3 py-1.5 text-[11px] border-b border-accent/10 shrink-0";

/**
 * The lines over a file being edited. Save sits among the floating actions, out of sight until the
 * pointer is over the file, so the first line is what says the buffer is being edited and whether
 * it holds unsaved work.
 */
function EditNotices({
  isDirty,
  isProcessing,
  saveError,
}: {
  isDirty: boolean;
  isProcessing: boolean;
  saveError: string | null;
}) {
  return (
    <>
      <div className={cn(NOTICE, "text-muted-foreground")}>
        {isDirty ? "Editing · unsaved changes" : "Editing"}
      </div>
      {isProcessing && (
        <div className={cn(NOTICE, "text-muted-foreground")}>
          <TriangleAlert className="w-3 h-3 shrink-0" />
          The agent is running and may write to this file. Your save will check first.
        </div>
      )}
      {saveError && (
        <div className={cn(NOTICE, "text-destructive bg-destructive/10")}>{saveError}</div>
      )}
    </>
  );
}

/** The editor, the draft's preview, or both side by side. */
function EditSurface({
  layout,
  editor,
  preview,
}: {
  layout: MarkdownEditLayout;
  editor: React.ReactNode;
  preview: React.ReactNode;
}) {
  if (layout === "preview") return preview;
  if (layout !== "split") return editor;
  // The two panes scroll independently. Aligning them needs source-line anchors on the rendered
  // blocks, which is a change to the shared markdown renderer — deliberately not part of this.
  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 overflow-hidden">
      <ResizablePanel defaultSize="50%" minSize="6rem" className="flex flex-col min-h-0">
        {editor}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel minSize="6rem" className="flex flex-col min-h-0">
        {preview}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

const SPLIT_TOO_NARROW = "The panel is too narrow for a split view — widen or maximize it";

/** The three markdown arrangements as one segmented group among the floating actions. */
function LayoutToggle({
  layout,
  onChoose,
  splitFits,
}: {
  layout: MarkdownEditLayout;
  onChoose: (layout: MarkdownEditLayout) => void;
  splitFits: boolean;
}) {
  return (
    // 24px items in a 3px-padded, bordered container come to 32, so the group lines up with every
    // other control rather than sitting short of them.
    <div className={cn(SEGMENT_GROUP, "flex items-center gap-0.5 shrink-0 mr-1")}>
      <SegmentThumb />
      {MARKDOWN_LAYOUTS.map(({ value, Icon, label }) => {
        // The stored preference survives an unavailable split; only this rendering of it is
        // withheld, so widening the panel brings split back without asking again.
        const unavailable = value === "split" && !splitFits;
        const chosen = layout === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <button
                type="button"
                onClick={() => onChoose(value)}
                disabled={unavailable}
                aria-label={label}
                aria-pressed={chosen}
                className={cn(
                  "relative inline-flex items-center justify-center size-6 rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none",
                  chosen ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{unavailable ? SPLIT_TOO_NARROW : label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** A question about the file's draft, with the answers the caller passes as children. */
function PaneDialog({
  open,
  onDismiss,
  title,
  description,
  returnFocus,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  title: string;
  description: string;
  /** Where the focus goes when it closes: the editor it came from may no longer take it. */
  returnFocus: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <AlertDialogContent
        // Focused here rather than handed to base-ui, which moves on to the first button inside.
        finalFocus={() => {
          returnFocus.current?.focus({ preventScroll: true });
          return false;
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>{children}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
