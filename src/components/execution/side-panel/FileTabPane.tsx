import { useEffect } from "react";
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
      {/* Save sits among the floating actions, out of sight until the pointer is over the file, so
          this line is what says the buffer is being edited and whether it holds unsaved work. */}
      {mode === "edit" && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-accent/10 shrink-0">
          {isDirty ? "Editing · unsaved changes" : "Editing"}
        </div>
      )}
      {mode === "edit" && isProcessing && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-accent/10 shrink-0">
          <TriangleAlert className="w-3 h-3 shrink-0" />
          The agent is running and may write to this file. Your save will check first.
        </div>
      )}
      {mode === "edit" && saveError && (
        <div className="flex items-center px-3 py-1.5 text-[11px] text-destructive bg-destructive/10 border-b border-accent/10 shrink-0">
          {saveError}
        </div>
      )}
      {effectiveLayout === "preview" ? (
        draftPreview
      ) : effectiveLayout === "split" ? (
        // The two panes scroll independently. Aligning them needs source-line anchors on the
        // rendered blocks, which is a change to the shared markdown renderer — deliberately not
        // part of this.
        <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 overflow-hidden">
          <ResizablePanel defaultSize="50%" minSize="6rem" className="flex flex-col min-h-0">
            {editor}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel minSize="6rem" className="flex flex-col min-h-0">
            {draftPreview}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        editor
      )}
    </div>
  ) : (
    <WorkspaceFileContent
      content={binaryMime ? (binaryContent ?? null) : (content ?? null)}
      isLoading={binaryMime ? binaryLoading : contentLoading}
      error={
        binaryMime
          ? binaryError
            ? String(binaryError)
            : null
          : contentError
            ? String(contentError)
            : null
      }
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
  // The stored preference survives an unavailable split; only this rendering of it is withheld, so
  // widening the panel brings split back without asking again.
  const layoutUnavailable = (value: MarkdownEditLayout) => value === "split" && !splitFits;
  const splitTooltip = "The panel is too narrow for a split view — widen or maximize it";

  return (
    <div
      data-side={side}
      className={cn("file-pane relative flex flex-col min-h-0 min-w-0", className)}
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
              // 24px items in a 3px-padded, bordered container come to 32, so the group lines up
              // with every other control rather than sitting short of them.
              <div className={cn(SEGMENT_GROUP, "flex items-center gap-0.5 shrink-0 mr-1")}>
                <SegmentThumb />
                {MARKDOWN_LAYOUTS.map(({ value, Icon, label }) => {
                  const unavailable = layoutUnavailable(value);
                  return (
                    <Tooltip key={value}>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <button
                          type="button"
                          onClick={() => chooseLayout(value)}
                          disabled={unavailable}
                          aria-label={label}
                          aria-pressed={effectiveLayout === value}
                          className={cn(
                            "relative inline-flex items-center justify-center size-6 rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none",
                            effectiveLayout === value
                              ? "text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Icon className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{unavailable ? splitTooltip : label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
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
              tooltip={isDirty ? "Discard unsaved changes" : "Close the editor"}
              disabled={saving}
              // Refetched only when it actually left — a dirty buffer raises the discard prompt
              // instead, and reading over an undecided edit would be worse than stale.
              onClick={() => {
                if (leaveEdit()) void refetch();
              }}
            >
              <X className="size-3.5" />
            </ToolbarButton>
          </>
        ) : (
          <>
            {editable && (
              <ToolbarButton
                label="Edit"
                tooltip="Edit this file"
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

      <AlertDialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) setConflict(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This file changed while you were editing</AlertDialogTitle>
            <AlertDialogDescription>
              {fileName} was written by something else — most likely the agent — since you started
              editing. Overwriting replaces those changes with yours; reloading discards yours.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
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
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={discardPrompt}
        onOpenChange={(open) => {
          if (!open) setDiscardPrompt(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {fileName} has edits that have not been written to disk. They will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discardDraft}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmClose}
        onOpenChange={(open) => {
          if (!open) onCloseResolved(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes to {fileName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Closing the tab loses the edits that have not been written to disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
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
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
