import { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider, PointerSensor } from "@dnd-kit/react";
import { PointerActivationConstraints } from "@dnd-kit/dom";
import { PanelLeft, FilePlus, FolderPlus, Eye, EyeOff, FileText, Columns2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
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
import { openFileWithConnection } from "@/services/connection.service";
import { LazyFileTree } from "./LazyFileTree";
import type { ConnectionKey } from "@/types/bindings";
import { FileNameDialog } from "./FileNameDialog";
import { folderLabel } from "./file-edit-utils";
import { useFileTreeState } from "./useFileTreeState";
import { ToolbarButton } from "./ToolbarButton";
import { ReviewLayout } from "@/components/execution/diff/ReviewLayout";
import { useReviewPanelLayout } from "@/components/execution/diff/useReviewPanelLayout";
import { isAbsolutePath } from "@/lib/path-utils";
import { FileTabPane } from "./FileTabPane";
import { FileTabBar, type TabDragData } from "./FileTabBar";
import {
  NO_TABS,
  closeTab,
  closeTabs,
  focusedPath,
  joinSides,
  moveTab,
  openTab,
  openToSide,
  removePaths,
  renamePaths,
  sideOf,
  type FileOpenRequest,
  type FileTabsState,
} from "./file-tabs";

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
  openRequest?: FileOpenRequest;
  /**
   * Whether the panel has the room for two files side by side. Losing it folds the second side
   * into the first, as restoring a maximized side panel does.
   */
  splitAllowed?: boolean;
  /** Drives the warning shown on entering edit mode: the agent may be writing this file. */
  isProcessing?: boolean;
  /** Lets the panel's host refuse to close it while an unsaved draft is open in any tab. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Reports the file in front, so the tab that holds this panel can name it on hover. */
  onSelectedChange?: (path: string | null) => void;
}

/** Where a dragged tab would land: a slot in a row of tabs, or a side's whole file. */
type DropTarget =
  | { kind: "row"; side: number; index: number }
  /** `right` opens the second side; `all` moves the tab onto the other one. */
  | { kind: "well"; side: number; zone: "right" | "all" };

/** The narrowest either side of a split can be dragged to. */
const MIN_SIDE_PX = 240;

// A press that moves a few pixels is still a click on the tab.
const TAB_SENSORS = [
  PointerSensor.configure({
    activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
  }),
];

function sameDrop(a: DropTarget | null, b: DropTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The Files panel, in a files session and in an agent session's side panel alike: the workspace
 * tree beside one or two sides of open files, each with its own row of tabs.
 *
 * Every open file keeps its pane mounted, in one flat list keyed by path, and a CSS grid places
 * each in its side. Moving a tab across is then a change of grid column rather than a remount, so
 * an unsaved draft goes with it.
 */
export function WorkspaceFilesPanel({
  workspacePath,
  connection,
  wslDistroName,
  isActive = true,
  openRequest,
  splitAllowed = true,
  isProcessing = false,
  onDirtyChange,
  onSelectedChange,
}: WorkspaceFilesPanelProps) {
  // The same layout the Changes tab uses in this very panel: a resizable column where there is
  // room, a floating overlay where there is not. Its own storage prefix, or toggling the list here
  // would toggle it there too. A panel opened without a file has nothing to show but "No file
  // open", so the list starts open there — including in the overlay layout, which otherwise starts
  // dismissed.
  const panel = useReviewPanelLayout("files", !openRequest);

  const [tabs, setTabs] = useState<FileTabsState>(() =>
    openRequest ? openTab(NO_TABS, openRequest.path) : NO_TABS,
  );
  const [reveal, setReveal] = useState(openRequest?.lines ? openRequest : null);
  const [seenNonce, setSeenNonce] = useState(openRequest?.nonce);
  // State following a changed input, so adjusted during render rather than from an effect.
  if (openRequest && openRequest.nonce !== seenNonce) {
    setSeenNonce(openRequest.nonce);
    setTabs((s) => openTab(s, openRequest.path));
    setReveal(openRequest.lines ? openRequest : null);
  }
  if (!splitAllowed && tabs.groups.length > 1) setTabs(joinSides(tabs));

  const openPaths = useMemo(() => tabs.groups.flatMap((g) => g.tabs), [tabs]);
  const selected = focusedPath(tabs);

  // Reported by every pane, including the ones closed since: only the open ones count.
  const [reportedDirty, setReportedDirty] = useState<ReadonlySet<string>>(() => new Set());
  const dirty = useMemo(
    () => new Set(openPaths.filter((p) => reportedDirty.has(p))),
    [openPaths, reportedDirty],
  );
  function handleDirtyChange(path: string, isDirty: boolean) {
    setReportedDirty((prev) => {
      if (prev.has(path) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  // Through refs because the hosts bind inline callbacks, which are new functions on every render.
  const onSelectedChangeRef = useRef(onSelectedChange);
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onSelectedChangeRef.current = onSelectedChange;
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onSelectedChangeRef.current?.(selected);
  }, [selected]);
  const anyDirty = dirty.size > 0;
  useEffect(() => {
    onDirtyChangeRef.current?.(anyDirty);
  }, [anyDirty]);

  const {
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
  } = useFileTreeState({
    connection,
    workspacePath,
    panelOpen: panel.panelOpen,
    isActive,
    selected,
    onOpen: (path) => setTabs((s) => openTab(s, path)),
    onRenamed: (from, to) => setTabs((s) => renamePaths(s, from, to)),
    onDeleted: (path) =>
      setTabs((s) => removePaths(s, (p) => p === path || p.startsWith(`${path}/`))),
  });

  // A file link in the stream can point outside the project — an agent reads
  // config from a home directory, a log from /tmp — and `handleOpenFile` hands
  // those over absolute because there is no root to make them relative to.
  // Joining one onto `workspacePath` anyway produced `C:/project/C:/Users/…`,
  // which the read rejects (os error 123) and the OS opener cannot find.
  const fullPathOf = (path: string) => (isAbsolutePath(path) ? path : `${workspacePath}/${path}`);

  /** A tab can go to the other side: there is one, or there is room for one and a tab to leave. */
  const canSplit = (side: number) =>
    splitAllowed && (tabs.groups.length > 1 || tabs.groups[side].tabs.length > 1);

  // Closing a tab with an unsaved draft asks first; its pane holds the question, since it is the
  // one that can save.
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
  function requestClose(side: number, path: string) {
    if (dirty.has(path)) setClosePrompt(path);
    else setTabs((s) => closeTab(s, side, path));
  }

  function openExternally(path: string) {
    const full = fullPathOf(path);
    openFileWithConnection(connection, full, {
      sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
      wslDistroName,
    }).catch((e) => toast.error(`Could not open ${full}: ${e}`));
  }

  const [drop, setDrop] = useState<DropTarget | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // The first side's share of the width. Not kept across restarts, as the tabs themselves are not.
  const [splitRatio, setSplitRatio] = useState(0.5);
  /** Keeps either side from being dragged narrower than a readable column. */
  function resizeTo(ratio: number) {
    const width = gridRef.current?.clientWidth ?? 0;
    const min = width > 0 ? Math.min(0.5, MIN_SIDE_PX / width) : 0.2;
    setSplitRatio(Math.min(1 - min, Math.max(min, ratio)));
  }

  /** Measured off the rows and wells on screen, against the pointer, as the mock does. */
  function dropTargetAt(x: number, y: number, from: TabDragData): DropTarget | null {
    const grid = gridRef.current;
    if (!grid) return null;
    const inside = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    for (const row of grid.querySelectorAll<HTMLElement>("[data-tab-row]")) {
      // The band around the row, so the gap after the last tab still counts as the row.
      if (!inside(row.parentElement!.getBoundingClientRect())) continue;
      const tabEls = [...row.querySelectorAll<HTMLElement>("[data-file-tab]")];
      const after = tabEls.findIndex((t) => {
        const r = t.getBoundingClientRect();
        return x < r.left + r.width / 2;
      });
      return {
        kind: "row",
        side: Number(row.dataset.tabRow),
        index: after < 0 ? tabEls.length : after,
      };
    }
    for (const well of grid.querySelectorAll<HTMLElement>("[data-well]")) {
      const r = well.getBoundingClientRect();
      if (!inside(r)) continue;
      const side = Number(well.dataset.well);
      if (tabs.groups.length === 1) {
        return canSplit(0) && x > r.left + r.width / 2
          ? { kind: "well", side, zone: "right" }
          : null;
      }
      return side !== from.side ? { kind: "well", side, zone: "all" } : null;
    }
    return null;
  }

  function applyDrop(target: DropTarget, from: TabDragData) {
    setTabs((s) =>
      target.kind === "row"
        ? moveTab(s, from.side, from.path, target.side, target.index)
        : moveTab(s, from.side, from.path, target.zone === "right" ? 1 : target.side, Infinity),
    );
  }

  const togglePanel = (
    <ToolbarButton
      label={panel.panelOpen ? "Hide file list" : "Show file list"}
      active={panel.panelOpen}
      onClick={() => panel.setPanelOpen(!panel.panelOpen)}
    >
      <PanelLeft className="size-4" />
    </ToolbarButton>
  );

  /**
   * The tree, wherever `ReviewLayout` decides to draw it, under the tools that act on it.
   * `onDismiss` is given only in the overlay layout, where the panel covers what it is navigating
   * and picking a file has to close it.
   */
  const renderTree = ({ onDismiss }: { onDismiss?: () => void }) => (
    <div ref={treeRef} className="flex flex-col flex-1 min-h-0">
      <div className={cn("flex items-center gap-1 h-10 px-2 shrink-0", !onDismiss && "mt-2")}>
        {togglePanel}
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
          label={showHidden ? "Hide hidden files" : "Show hidden files"}
          active={showHidden}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </ToolbarButton>
      </div>
      <LazyFileTree
        root={workspacePath}
        connection={connection}
        selectedFile={selected}
        onSelectFile={(path) => {
          setTabs((s) => openTab(s, path));
          onDismiss?.();
        }}
        onOpenFileToSide={
          splitAllowed
            ? (path) => {
                setTabs((s) => openToSide(s, path));
                onDismiss?.();
              }
            : undefined
        }
        dirtyFiles={dirty}
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

  const split = tabs.groups.length > 1;
  // Beside the tree, each side is a glass well under its own row of tabs; with the tree floating
  // or hidden the panel's own glass is the surface, and a line under the tabs is all that is left.
  // The second side butts against the first with a square corner, so its left edge meets their
  // shared top edge in a T rather than a second rounded well beside the first.
  const well = (side: number) =>
    panel.inset
      ? cn(
          "inner-glass border-t overflow-hidden",
          side === 0 ? "rounded-tl-[18px] border-l" : "border-l",
        )
      : cn("border-t border-accent/10", side > 0 && "border-l");
  const place = (side: number, row: number) => ({ gridColumn: side + 1, gridRow: row });

  return (
    <div
      className="absolute inset-0 flex flex-col"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && selected) {
          // Kept from the Agents view's own Ctrl+W, which closes the whole session: with focus in
          // here it closes the file in front, and only with no file open does it reach the session.
          e.preventDefault();
          e.stopPropagation();
          requestClose(tabs.focus, selected);
        }
      }}
    >
      <ReviewLayout panel={panel} renderPanel={renderTree} plain>
        <DragDropProvider
          sensors={TAB_SENSORS}
          onDragMove={(event) => {
            const from = event.operation.source?.data as TabDragData | undefined;
            const { x, y } = event.operation.position.current;
            const next = from ? dropTargetAt(x, y, from) : null;
            setDrop((prev) => (sameDrop(prev, next) ? prev : next));
          }}
          onDragEnd={(event) => {
            const from = event.operation.source?.data as TabDragData | undefined;
            if (!event.canceled && from && drop) applyDrop(drop, from);
            setDrop(null);
          }}
        >
          <div
            ref={gridRef}
            className="relative grid flex-1 min-h-0"
            style={{
              gridTemplateColumns: split
                ? `minmax(0, ${splitRatio}fr) minmax(0, ${1 - splitRatio}fr)`
                : "minmax(0, 1fr)",
              gridTemplateRows: "auto minmax(0, 1fr)",
            }}
            // Whatever is pressed in a side — a tab, the file — makes it the one the tree opens on.
            onPointerDownCapture={(e) => {
              const at = (e.target as HTMLElement).closest<HTMLElement>("[data-side]");
              const side = at ? Number(at.dataset.side) : tabs.focus;
              if (side !== tabs.focus) setTabs((s) => ({ ...s, focus: side }));
            }}
          >
            {tabs.groups.map((group, side) => (
              <div
                key={`band-${side}`}
                data-side={side}
                className={cn("flex items-center gap-1 h-10 px-2 min-w-0", panel.inset && "mt-2")}
                style={place(side, 1)}
              >
                {side === 0 && !panel.panelOpen && togglePanel}
                <FileTabBar
                  side={side}
                  tabs={group.tabs}
                  active={group.active}
                  focused={!split || side === tabs.focus}
                  dirty={dirty}
                  dropIndex={drop?.kind === "row" && drop.side === side ? drop.index : null}
                  canMove={canSplit(side)}
                  split={split}
                  onActivate={(path) => setTabs((s) => openTab(s, path, side))}
                  onClose={(path) => requestClose(side, path)}
                  onCloseMany={(close) =>
                    setTabs((s) => closeTabs(s, side, (p, i) => !dirty.has(p) && close(p, i)))
                  }
                  onMove={(path) =>
                    setTabs((s) => moveTab(s, side, path, side === 0 ? 1 : 0, Infinity))
                  }
                  onOpenExternally={openExternally}
                  fullPathOf={fullPathOf}
                />
              </div>
            ))}

            {openPaths.map((path) => {
              const side = sideOf(tabs, path);
              const shown = tabs.groups[side].active === path;
              return (
                <FileTabPane
                  key={path}
                  path={path}
                  fullPath={fullPathOf(path)}
                  connection={connection}
                  wslDistroName={wslDistroName}
                  isActive={isActive && shown}
                  isProcessing={isProcessing}
                  revealLines={reveal?.path === path ? reveal.lines : undefined}
                  revealKey={reveal?.nonce}
                  onDirtyChange={(d) => handleDirtyChange(path, d)}
                  confirmClose={closePrompt === path}
                  onCloseResolved={(close) => {
                    setClosePrompt(null);
                    if (close)
                      setTabs((s) => {
                        const at = sideOf(s, path);
                        return at < 0 ? s : closeTab(s, at, path);
                      });
                  }}
                  className={cn(well(side), !shown && "hidden")}
                  style={place(side, 2)}
                  side={side}
                />
              );
            })}

            {tabs.groups[0].tabs.length === 0 && (
              <div
                className={cn(
                  well(0),
                  "flex flex-col items-center justify-center gap-1.5 text-xs text-muted-foreground",
                )}
                style={place(0, 2)}
              >
                <FileText className="size-5" />
                No file open
              </div>
            )}

            {/* The line between the sides, dragged to share the width differently. A grid item placed
                absolutely, so it sits on the second side's left edge, under the tabs, without
                taking a column of its own. Double-click evens the sides again. */}
            {split && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the sides"
                aria-valuenow={Math.round(splitRatio * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={0}
                onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const box = gridRef.current!.getBoundingClientRect();
                  resizeTo((e.clientX - box.left) / box.width);
                }}
                onDoubleClick={() => setSplitRatio(0.5)}
                onKeyDown={(e) => {
                  const step = e.key === "ArrowLeft" ? -0.05 : e.key === "ArrowRight" ? 0.05 : 0;
                  if (step === 0) return;
                  e.preventDefault();
                  resizeTo(splitRatio + step);
                }}
                className="group/split absolute inset-y-0 left-0 z-30 flex w-2 -translate-x-1/2 cursor-col-resize items-center justify-center outline-none"
                style={place(1, 2)}
              >
                <div className="h-6 w-1 rounded-lg bg-border transition-colors group-hover/split:bg-accent group-focus-visible/split:bg-accent" />
              </div>
            )}

            {/* Over each side, where a dragged tab is shown landing: on the right half of a lone
                side to open a second, or on the other side to move there. */}
            {tabs.groups.map((_, side) => (
              <div
                key={`well-${side}`}
                data-well={side}
                className="relative z-20 pointer-events-none"
                style={place(side, 2)}
              >
                {drop?.kind === "well" && drop.side === side && (
                  <div
                    className={cn(
                      "absolute top-1.5 bottom-1.5 flex items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-accent/60 bg-accent/14 backdrop-blur-sm text-xs text-foreground",
                      drop.zone === "right" ? "left-1/2 right-1.5" : "left-1.5 right-1.5",
                    )}
                  >
                    <Columns2 className="size-3.5" />
                    {drop.zone === "right" ? "Open to the side" : "Move here"}
                  </div>
                )}
              </div>
            ))}
          </div>
        </DragDropProvider>
      </ReviewLayout>

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
            <AlertDialogAction
              variant="destructive"
              disabled={deletePending}
              onClick={() => void handleDeleteConfirm()}
            >
              {deletePending && <Spinner className="w-3.5 h-3.5" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
