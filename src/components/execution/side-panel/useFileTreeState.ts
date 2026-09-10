import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  connectionQueryKeys,
  useCreateFile,
  useCreateDirectory,
  useRenamePath,
  useDeletePath,
  useListDirContents,
} from "@/services/connection.service";
import { folderLabel } from "./file-edit-utils";
import type { FileTreeAction, FileTreeTarget } from "./LazyFileTree";
import type { ConnectionKey } from "@/types/bindings";

export type NameDialogState =
  | { kind: "new-file" | "new-folder"; parentAbsolutePath: string; siblings: string[] }
  | { kind: "rename"; target: FileTreeTarget };

interface UseFileTreeStateOptions {
  connection: ConnectionKey;
  /** Root the tree is browsed from and relative selections resolve against. */
  workspacePath: string;
  /** Whether the list is on screen — an unopened list mounts no directory queries. */
  panelOpen: boolean;
  /** Whether this tab is the visible one. */
  isActive: boolean;
  initialPath?: string;
}

/**
 * What the tree is showing, and everything that changes its shape.
 *
 * Selection, expansion and the create/rename/delete operations are one unit because they all speak
 * absolute paths against `workspacePath` and all have to keep `selected` pointing somewhere real —
 * a rename follows the open file, a delete clears it.
 */
export function useFileTreeState({
  connection,
  workspacePath,
  panelOpen,
  isActive,
  initialPath,
}: UseFileTreeStateOptions) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);
  const [showHidden, setShowHidden] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileTreeTarget | null>(null);
  /** `null` is the workspace root. Drives the tree highlight and the header's create buttons. */
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const targetFolder = selectedFolder ?? workspacePath;
  const targetLabel = folderLabel(targetFolder, workspacePath);

  // Only to give the header's create buttons their collision check. It shares the cache entry the
  // tree already mounts for that directory, so while the list is open it costs no extra request;
  // while it is closed the buttons are not mounted either, and an empty path disables the query.
  const { data: targetEntries } = useListDirContents(
    connection,
    panelOpen ? targetFolder : "",
    showHidden,
  );
  const targetSiblings = useMemo(() => (targetEntries ?? []).map((e) => e.name), [targetEntries]);

  const createFile = useCreateFile();
  const createDirectory = useCreateDirectory();
  const renamePath = useRenamePath();
  const deletePath = useDeletePath();

  // Invalidate all cached dir listings for this connection when the tab regains focus. Only
  // mounted queries (root + expanded dirs) actually refetch.
  useEffect(() => {
    if (!isActive) return;
    void queryClient.invalidateQueries({
      queryKey: [...connectionQueryKeys.fileBrowser(), "dir", connection],
    });
  }, [isActive, queryClient, connection]);

  useEffect(() => {
    if (!panelOpen || !selected) return;
    const id = setTimeout(() => {
      treeRef.current
        ?.querySelector(".selected-file-item")
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(id);
  }, [panelOpen, selected]);

  /** The tree and the mutations speak absolute paths; `selected` is relative to the workspace. */
  function toSelection(absolutePath: string): string {
    const prefix = `${workspacePath}/`;
    return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
  }

  function handleRefresh() {
    void queryClient.invalidateQueries({
      queryKey: [...connectionQueryKeys.fileBrowser(), "dir", connection],
    });
  }

  function handleTreeAction(action: FileTreeAction) {
    if (action.type === "delete") setDeleteTarget(action.target);
    else if (action.type === "rename") setNameDialog({ kind: "rename", target: action.target });
    else
      setNameDialog({
        kind: action.type,
        parentAbsolutePath: action.parentAbsolutePath,
        siblings: action.siblings,
      });
  }

  function createInTarget(kind: "new-file" | "new-folder") {
    setNameDialog({ kind, parentAbsolutePath: targetFolder, siblings: targetSiblings });
  }

  // The mutations already raise a toast through `createErrorToastHandler`, so a failure here only
  // has to leave the dialog open with the name still in it — and be caught, or the rejection
  // escapes the `void` at the call site as an unhandled one.
  async function handleNameConfirm(name: string) {
    if (!nameDialog) return;
    try {
      if (nameDialog.kind === "rename") {
        const { target } = nameDialog;
        const to = `${target.parentAbsolutePath}/${name}`;
        await renamePath.mutateAsync({ connection, from: target.absolutePath, to });
        // Following the rename keeps the open file open rather than blanking the pane. Only the
        // exact file matters — a renamed ancestor directory is not tracked here.
        if (selected != null && toSelection(target.absolutePath) === selected) {
          setSelected(toSelection(to));
        }
      } else {
        const path = `${nameDialog.parentAbsolutePath}/${name}`;
        if (nameDialog.kind === "new-file") {
          await createFile.mutateAsync({ connection, path });
          setSelected(toSelection(path));
        } else {
          await createDirectory.mutateAsync({ connection, path });
        }
      }
      setNameDialog(null);
    } catch {
      // Reported by the mutation's own error handler.
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    try {
      await deletePath.mutateAsync({
        connection,
        path: deleteTarget.absolutePath,
        recursive: deleteTarget.isDir,
      });
      if (selected != null && toSelection(deleteTarget.absolutePath) === selected) {
        setSelected(null);
      }
      setDeleteTarget(null);
    } catch {
      // Reported by the mutation's own error handler.
    }
  }

  return {
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
    /** Any of the three writes the name dialog can start, for its own pending state. */
    namePending: renamePath.isPending || createFile.isPending || createDirectory.isPending,
    deletePending: deletePath.isPending,
    nameDialog,
    setNameDialog,
    deleteTarget,
    setDeleteTarget,
    handleRefresh,
    handleTreeAction,
    createInTarget,
    handleNameConfirm,
    handleDeleteConfirm,
  };
}
