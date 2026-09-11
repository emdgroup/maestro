import { useEffect } from "react";
import {
  PanelLeft,
  ExternalLink,
  FilePlus,
  FolderPlus,
  FolderDown,
  Eye,
  EyeOff,
  FilePen,
  Save,
  X,
  MoreHorizontal,
  Code,
  Columns2,
  Link2,
  Unlink2,
  TriangleAlert,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/ui/dropdown-menu";
import { useReadFile, useReadFileBinary } from "@/services/connection.service";
import { binaryMimeForExtension } from "@/components/execution/activity/fileTypeUtils";
import { LazyFileTree } from "./LazyFileTree";
import type { ConnectionKey } from "@/types/bindings";
import { WorkspaceFileContent } from "./WorkspaceFileContent";
import { FileEditor } from "./FileEditor";
import { FileNameDialog } from "./FileNameDialog";
import {
  canEditFile,
  filePollInterval,
  folderLabel,
  type MarkdownEditLayout,
} from "./file-edit-utils";
import { useFileDraft } from "./useFileDraft";
import { useFileTreeState } from "./useFileTreeState";
import { useMarkdownLayout } from "./useMarkdownLayout";
import { ToolbarButton } from "./ToolbarButton";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/ui/resizable";
import { ReviewLayout } from "@/components/execution/diff/ReviewLayout";
import { useReviewPanelLayout } from "@/components/execution/diff/useReviewPanelLayout";
import { openFileWithConnection, downloadFileToFolder, opensViaHostCopy } from "@/lib/file-opener";
import { isAbsolutePath } from "@/lib/path-utils";
import { TransferIcon } from "./TransferIcon";
import { transferTooltip, useFileTransfer } from "./useFileTransfer";

interface WorkspaceFilesPanelProps {
  /**
   * Root the tree is browsed from and relative selections resolve against — the
   * session's own working directory, which for an isolated task is the worktree
   * rather than the project root.
   */
  workspacePath: string;
  connection: ConnectionKey;
  wslDistroName?: string;
  isActive?: boolean;
  initialPath?: string;
  /** Drives the warning shown on entering edit mode: the agent may be writing this file. */
  isProcessing?: boolean;
  /** Lets the panel's own tab refuse to close while an unsaved draft is open. */
  onDirtyChange?: (dirty: boolean) => void;
}

/** The three markdown arrangements, rendered as a group in the header and as radio items in the
 *  overflow menu when the header is too narrow to hold the group. */
const MARKDOWN_LAYOUTS: ReadonlyArray<{
  value: MarkdownEditLayout;
  Icon: typeof Code;
  label: string;
}> = [
  { value: "source", Icon: Code, label: "Source only" },
  { value: "split", Icon: Columns2, label: "Source and preview" },
  { value: "preview", Icon: Eye, label: "Preview only" },
];

export function WorkspaceFilesPanel({
  workspacePath,
  connection,
  wslDistroName,
  isActive = true,
  initialPath,
  isProcessing = false,
  onDirtyChange,
}: WorkspaceFilesPanelProps) {
  const openTransfer = useFileTransfer();
  const downloadTransfer = useFileTransfer();

  // The same layout the Changes tab uses in this very panel: a resizable column where there is
  // room, a floating overlay where there is not. That measurement is what the pin used to be doing
  // by hand. Its own storage prefix, or toggling the list here would toggle it there too.
  // A tab opened without a file has nothing but "No file selected" to show, so the list starts
  // open there — including in the overlay layout, which otherwise starts dismissed.
  const panel = useReviewPanelLayout("files", !initialPath);

  const tree = useFileTreeState({
    connection,
    workspacePath,
    panelOpen: panel.panelOpen,
    isActive,
    initialPath,
  });
  const {
    selected,
    setSelected,
    showHidden,
    setShowHidden,
    expandedFolders,
    setExpandedFolders,
    selectedFolder,
    setSelectedFolder,
    treeRef,
    targetLabel,
    namePending,
    deletePending,
    nameDialog,
    setNameDialog,
    deleteTarget,
    setDeleteTarget,
    handleRefresh,
    handleTreeAction,
    createInTarget,
    handleNameConfirm,
    handleDeleteConfirm,
  } = tree;

  // A file link in the stream can point outside the project — an agent reads
  // config from a home directory, a log from /tmp — and `handleOpenFile` hands
  // those over absolute because there is no root to make them relative to.
  // Joining one onto `workspacePath` anyway produced `C:/project/C:/Users/…`,
  // which the read rejects (os error 123) and the OS opener cannot find.
  const fullPath = selected
    ? isAbsolutePath(selected)
      ? selected
      : `${workspacePath}/${selected}`
    : null;
  const fileDir = fullPath ? fullPath.replace(/\/[^/]+$/, "") : undefined;
  const binaryMime = selected ? binaryMimeForExtension(selected) : undefined;

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
  } = useReadFile(connection, binaryMime ? null : fullPath, {
    refetchInterval: (query) =>
      filePollInterval({ hasError: query.state.error != null, isActive, mode }),
  });
  const {
    data: binaryContent,
    isLoading: binaryLoading,
    error: binaryError,
  } = useReadFileBinary(connection, binaryMime ? fullPath : null);

  useEffect(() => {
    if (isActive && fullPath && !binaryMime && mode === "view") {
      void refetch();
    }
  }, [isActive, fullPath, binaryMime, mode, refetch]);

  const basename = selected ? (selected.split("/").pop() ?? selected) : null;
  const editable = canEditFile({ fileName: selected, binaryMime, error: contentError, content });
  const isMarkdown = selected?.toLowerCase().endsWith(".md") ?? false;

  // Markdown, images, PDFs, load errors and the empty state keep their own renderers; plain text is
  // the editor in both modes. Keeping the same element type across the mode toggle is what stops
  // React remounting it — and with it the scroll position.
  const showsEditorSurface =
    (mode === "edit" && fullPath != null) || (mode === "view" && editable && !isMarkdown);

  const {
    chooseLayout,
    effectiveLayout,
    splitFits,
    scrollSync,
    chooseScrollSync,
    editAreaRef,
    setEditorScroller,
    setPreviewScroller,
  } = useMarkdownLayout({ isMarkdown, showsEditorSurface });

  // Bridges the two hooks: which file is open is the tree's business, but whether leaving the
  // current one is allowed to happen without asking is the draft's.
  function handleSelectFile(next: string) {
    if (isDirty) {
      setDiscardPrompt({ reason: "select", next });
      return;
    }
    setSelected(next);
  }

  async function handleOpen() {
    if (!fullPath) return;
    const transferId = `open-${Date.now()}`;
    await openTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () =>
        openFileWithConnection(connection, fullPath, {
          sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
          transferId,
          wslDistroName,
        }),
      // The file opening is its own confirmation, so success stays quiet here.
    });
  }

  async function handleDownload() {
    if (!fullPath || connection.type === "local") return;
    const transferId = `dl-${Date.now()}`;
    await downloadTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () => downloadFileToFolder(connection, fullPath, transferId),
      describeDone: (dest) => (dest === null ? null : `Saved to ${dest}`),
    });
  }

  /**
   * The tree, wherever `ReviewLayout` decides to draw it. `onDismiss` is given only in the overlay
   * layout, where the panel covers what it is navigating and picking a file has to close it.
   */
  const renderTree = ({ onDismiss }: { onDismiss?: () => void }) => (
    <div ref={treeRef} className="flex flex-col flex-1 min-h-0">
      <LazyFileTree
        root={workspacePath}
        connection={connection}
        selectedFile={selected}
        onSelectFile={(path) => {
          handleSelectFile(path);
          onDismiss?.();
        }}
        expandedFolders={expandedFolders}
        onExpandedFoldersChange={setExpandedFolders}
        showHidden={showHidden}
        onAction={handleTreeAction}
        onRefresh={handleRefresh}
        selectedFolder={selectedFolder}
        onSelectFolder={setSelectedFolder}
        className="flex-1 min-h-0"
      />
    </div>
  );

  // One editor for both modes, so read and edit cannot disagree about colour and the toggle keeps
  // the scroll position. In view mode it follows what was read from disk; in edit mode it owns the
  // draft and reports it back.
  const editor = (
    <FileEditor
      doc={mode === "edit" ? draft : (content ?? "")}
      docEpoch={docEpoch}
      fileName={selected ?? ""}
      readOnly={mode === "view"}
      onChange={setDraft}
      onSave={() => void handleSave()}
      onScrollerChange={setEditorScroller}
    />
  );

  // The draft, not the file — previewing what is on disk while editing something else would be
  // worse than no preview at all.
  const draftPreview = (
    <WorkspaceFileContent
      content={draft}
      isLoading={false}
      error={null}
      fileName={selected}
      fileDir={fileDir}
      scrollRef={setPreviewScroller}
    />
  );

  const body = showsEditorSurface ? (
    <div ref={editAreaRef} data-slot="markdown-edit-area" className="flex-1 flex flex-col min-h-0">
      {mode === "edit" && isProcessing && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground bg-muted/40 border-b border-border shrink-0">
          <TriangleAlert className="w-3 h-3 shrink-0" />
          The agent is running and may write to this file. Your save will check first.
        </div>
      )}
      {mode === "edit" && saveError && (
        <div className="flex items-center px-3 py-1.5 text-[11px] text-destructive bg-destructive/10 border-b border-border shrink-0">
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
      fileName={selected}
      mimeType={binaryMime}
      fileDir={fileDir}
    />
  );

  const inEdit = selected != null && mode === "edit";
  const saveDisabled = saving || !isDirty;
  const showLayoutGroup = inEdit && isMarkdown;
  const showSyncToggle = inEdit && effectiveLayout === "split";
  const syncLabel = scrollSync ? "Turn off synced scrolling" : "Turn on synced scrolling";
  const hiddenLabel = showHidden ? "Hide hidden files" : "Show hidden files";
  // The stored preference survives an unavailable split; only this rendering of it is withheld, so
  // widening the panel brings split back without asking again.
  const layoutUnavailable = (value: MarkdownEditLayout) => value === "split" && !splitFits;
  const splitTooltip = "The panel is too narrow for a split view — widen or maximize it";

  return (
    <div className="absolute inset-0 flex flex-col bg-card">
      {/* No bottom border and the same surface as the file panel below it, so the two read as one
          thing rather than a header stacked on a second header. It takes the gap above it that the
          inset layout leaves below, which is what keeps its contents on the band's centre line.

          A container query rather than a media one: what this row has to fit is decided by the side
          panel's width, which is nothing the viewport knows. */}
      <div
        className={cn(
          "@container flex items-center h-10 px-2 bg-card shrink-0 gap-1",
          panel.inset && "mt-2",
        )}
      >
        <div className="flex items-center gap-0.5 shrink-0">
          <ToolbarButton
            label={panel.panelOpen ? "Hide file list" : "Show file list"}
            active={panel.panelOpen}
            onClick={() => panel.setPanelOpen(!panel.panelOpen)}
          >
            <PanelLeft className="size-4" />
          </ToolbarButton>

          {/* Mounted with the list they act on, so they arrive and leave with it. They sit left of
              the centred filename, which does mean the name shifts when the list is toggled —
              inherent to flex centring, and the price of matching the Changes tab. */}
          {panel.panelOpen && (
            <div className="flex items-center gap-0.5 @max-[280px]:hidden">
              <ToolbarButton
                label={`New file in ${targetLabel}`}
                onClick={() => createInTarget("new-file")}
              >
                <FilePlus className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                label={`New folder in ${targetLabel}`}
                onClick={() => createInTarget("new-folder")}
              >
                <FolderPlus className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                label={hiddenLabel}
                active={showHidden}
                onClick={() => setShowHidden((v) => !v)}
              >
                {showHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </ToolbarButton>
            </div>
          )}

          {/* Everything the row cannot afford below 280px. The layout group has to be in here or
              the arithmetic does not close: at the docked 224px it is 92px on its own, which is
              more than the filename would have left. */}
          {(panel.panelOpen || showLayoutGroup || showSyncToggle) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More actions"
                    className="hidden @max-[280px]:inline-flex text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto whitespace-nowrap">
                {panel.panelOpen && (
                  <>
                    <DropdownMenuItem onClick={() => createInTarget("new-file")}>
                      <FilePlus className="size-3.5" />
                      New file in {targetLabel}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => createInTarget("new-folder")}>
                      <FolderPlus className="size-3.5" />
                      New folder in {targetLabel}
                    </DropdownMenuItem>
                    <DropdownMenuCheckboxItem
                      checked={showHidden}
                      onCheckedChange={(next) => setShowHidden(next)}
                    >
                      Show hidden files
                    </DropdownMenuCheckboxItem>
                  </>
                )}
                {panel.panelOpen && (showLayoutGroup || showSyncToggle) && (
                  <DropdownMenuSeparator />
                )}
                {showLayoutGroup && (
                  <DropdownMenuRadioGroup
                    value={effectiveLayout}
                    onValueChange={(next) => chooseLayout(next as MarkdownEditLayout)}
                  >
                    {MARKDOWN_LAYOUTS.map(({ value, Icon, label }) => (
                      <DropdownMenuRadioItem
                        key={value}
                        value={value}
                        disabled={layoutUnavailable(value)}
                      >
                        <Icon className="size-3.5" />
                        {label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                )}
                {showSyncToggle && (
                  <DropdownMenuCheckboxItem
                    checked={scrollSync}
                    onCheckedChange={(next) => chooseScrollSync(next)}
                  >
                    Synced scrolling
                  </DropdownMenuCheckboxItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Centred, exactly as the Changes tab's header centres its own. The relative path is the
            title rather than a second line: this bar is 40px tall and can be 224px wide. */}
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 overflow-hidden">
          {basename ? (
            <>
              <Tooltip trackCursorAxis="x">
                <TooltipTrigger
                  render={<span className="text-xs font-mono text-muted-foreground truncate" />}
                >
                  {basename}
                </TooltipTrigger>
                <TooltipContent className="max-w-md break-all">{selected}</TooltipContent>
              </Tooltip>
              {isDirty && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="size-2 rounded-full bg-accent shrink-0"
                        aria-label="Unsaved changes"
                      />
                    }
                  />
                  <TooltipContent>Unsaved changes</TooltipContent>
                </Tooltip>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground truncate">No file selected</span>
          )}
        </div>

        {selected && (
          <div className="flex items-center gap-0.5 shrink-0">
            {mode === "edit" ? (
              // The pairing that confused people was a floppy disk beside a tick: the tick reads
              // as "confirm", which is the opposite of what it does on a dirty buffer. An X always
              // means "leave", and its tooltip is what says whether leaving will cost anything.
              <>
                {/* Only in split: with one pane there is nothing to keep in step, and a toggle
                    that does nothing is worse than no toggle. It sits beside what it modifies. */}
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
                    className="@max-[280px]:hidden"
                  >
                    {scrollSync ? <Link2 className="size-3.5" /> : <Unlink2 className="size-3.5" />}
                  </ToolbarButton>
                )}
                {showLayoutGroup && (
                  // 28px items in a 2px-padded container come to 32, so the group lines up with
                  // every other control rather than sitting 4px short of them.
                  <div className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5 shrink-0 @max-[280px]:hidden">
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
                                "inline-flex items-center justify-center size-7 rounded transition-colors disabled:opacity-40 disabled:pointer-events-none",
                                effectiveLayout === value
                                  ? "text-foreground bg-background shadow-sm"
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
                {/* Set apart from the layout group: that group is a view preference, this writes
                    to disk, and at `gap-0.5` the two read as one strip of controls. */}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Save"
                        onClick={() => void handleSave()}
                        disabled={saveDisabled}
                        // The accent is what says "there is unsaved work here". Wearing it with
                        // nothing to save promised an action the button would not perform.
                        className={cn("ml-1.5", !saveDisabled && "text-accent")}
                      />
                    }
                  >
                    {saving ? <Spinner className="size-3.5" /> : <Save className="size-3.5" />}
                  </TooltipTrigger>
                  <TooltipContent>Save (Ctrl+S)</TooltipContent>
                </Tooltip>
                {/* One icon, two meanings, and the tooltip is what separates them. `leaveEdit`
                    raises the discard prompt itself when there is something to discard. */}
                <ToolbarButton
                  label={isDirty ? "Discard" : "Close"}
                  tooltip={isDirty ? "Discard unsaved changes" : "Close the editor"}
                  disabled={saving}
                  // Refetched only when it actually left — a dirty buffer raises the discard
                  // prompt instead, and reading over an undecided edit would be worse than stale.
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
                <ToolbarButton
                  label={
                    opensViaHostCopy(connection)
                      ? "Download and open"
                      : "Open in default application"
                  }
                  tooltip={transferTooltip(
                    openTransfer.state,
                    opensViaHostCopy(connection)
                      ? "Download and open"
                      : "Open in default application",
                  )}
                  disabled={openTransfer.pending}
                  onClick={() => void handleOpen()}
                  className={cn(openTransfer.state.status === "error" && "text-destructive")}
                >
                  <TransferIcon
                    state={openTransfer.state}
                    idle={<ExternalLink className="size-3.5" />}
                  />
                </ToolbarButton>
                {connection.type !== "local" && (
                  <ToolbarButton
                    label="Download to…"
                    tooltip={transferTooltip(downloadTransfer.state, "Download to…")}
                    disabled={downloadTransfer.pending}
                    onClick={() => void handleDownload()}
                    className={cn(
                      downloadTransfer.state.status === "error" && "text-destructive",
                      downloadTransfer.state.status === "done" && "text-emerald-600",
                    )}
                  >
                    <TransferIcon
                      state={downloadTransfer.state}
                      idle={<FolderDown className="size-3.5" />}
                    />
                  </ToolbarButton>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* A resizable column where there is room, a floating overlay where there is not — the same
          toggle drives either, and the same component decides which. */}
      <ReviewLayout panel={panel} renderPanel={renderTree}>
        {body}
      </ReviewLayout>

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
              {basename} was written by something else — most likely the agent — since you started
              editing. Overwriting replaces those changes with yours; reloading discards yours.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => conflict && handleReloadFromDisk(conflict.onDisk)}>
              Reload, discarding mine
            </AlertDialogAction>
            <AlertDialogAction onClick={() => void handleOverwrite()}>Overwrite</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={discardPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setDiscardPrompt(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {basename} has edits that have not been written to disk. They will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const prompt = discardPrompt;
                discardDraft();
                if (prompt?.reason === "select") setSelected(prompt.next);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FileNameDialog
        open={nameDialog !== null}
        title={
          nameDialog?.kind === "rename"
            ? "Rename"
            : nameDialog?.kind === "new-folder"
              ? "New folder"
              : "New file"
        }
        description={
          nameDialog?.kind === "rename"
            ? `Rename “${nameDialog.target.name}”.`
            : // Naming the destination is the whole point: the header's buttons act on the
              // highlighted folder, and "somewhere" is not something a user can verify.
              `Created in ${folderLabel(nameDialog?.parentAbsolutePath ?? workspacePath, workspacePath)}.`
        }
        confirmLabel={nameDialog?.kind === "rename" ? "Rename" : "Create"}
        initialName={nameDialog?.kind === "rename" ? nameDialog.target.name : ""}
        siblings={
          nameDialog?.kind === "rename"
            ? // Its own name is not a collision: typing a change and undoing it must not leave the
              // dialog stuck reporting that the file already exists.
              nameDialog.target.siblings.filter((s) => s !== nameDialog.target.name)
            : (nameDialog?.siblings ?? [])
        }
        pending={namePending}
        onConfirm={(name) => void handleNameConfirm(name)}
        onClose={() => setNameDialog(null)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletePending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.isDir ? "folder" : "file"} “{deleteTarget?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.isDir
                ? `Everything inside “${deleteTarget.name}” is deleted with it. This cannot be undone from Maestro.`
                : "This cannot be undone from Maestro."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={deletePending} onClick={() => void handleDeleteConfirm()}>
              {deletePending && <Spinner className="w-3.5 h-3.5" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
