import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useCreateFile,
  useCreateDirectory,
  useRenamePath,
  useDeletePath,
  useListDirContents,
  useInvalidateFileBrowser,
} from "@/services/connection.service";
import { basename, isAbsolutePath } from "@/lib/path-utils";
import { folderLabel } from "./file-edit-utils";
import type { FileTreeAction, FileTreeTarget } from "./LazyFileTree";
import type { ConnectionKey } from "@/types/bindings";

export type NameDialogState =
  | { kind: "new-file" | "new-folder"; parentAbsolutePath: string; siblings: string[] }
  | { kind: "rename"; target: FileTreeTarget };

/** What the name dialog says for `dialog`, and the names a new one may not take. */
export function nameDialogCopy(dialog: NameDialogState | null, workspacePath: string) {
  if (dialog?.kind === "rename") {
    const { name, siblings } = dialog.target;
    return {
      title: "Rename",
      description: `Rename “${name}”.`,
      confirmLabel: "Rename",
      initialName: name,
      // Its own name is not a collision: typing a change and undoing it must not leave the dialog
      // stuck reporting that the file already exists.
      siblings: siblings.filter((s) => s !== name),
    };
  }
  return {
    title: dialog?.kind === "new-folder" ? "New folder" : "New file",
    // Naming the destination is the whole point: the header's buttons act on the highlighted
    // folder, and "somewhere" is not something a user can verify.
    description: `Created in ${folderLabel(dialog?.parentAbsolutePath ?? workspacePath, workspacePath)}.`,
    confirmLabel: "Create",
    initialName: "",
    siblings: dialog?.siblings ?? [],
  };
}

/**
 * Absolute path of the folder holding `relativePath`, or `null` for the workspace root — which is
 * also what a selection outside the workspace gets, since no row in the tree represents it.
 */
function folderOf(relativePath: string, workspacePath: string): string | null {
  const slash = relativePath.lastIndexOf("/");
  if (slash === -1 || isAbsolutePath(relativePath)) return null;
  return `${workspacePath}/${relativePath.slice(0, slash)}`;
}

interface UseFileTreeStateOptions {
  connection: ConnectionKey;
  /** Root the tree is browsed from and relative selections resolve against. */
  workspacePath: string;
  /** Whether the list is on screen — an unopened list mounts no directory queries. */
  panelOpen: boolean;
  /** Whether this tab is the visible one. */
  isActive: boolean;
  /** The file on screen, relative to the workspace, which the tree highlights. */
  selected: string | null;
  /** Open files with unsaved changes, relative to the workspace: renaming or deleting one waits. */
  dirty: ReadonlySet<string>;
  /** Opens a file the user just created. */
  onOpen: (relativePath: string) => void;
  /** Follows a rename of a file or folder, both relative to the workspace. */
  onRenamed: (from: string, to: string) => void;
  /** Lets go of a deleted file or folder, relative to the workspace. */
  onDeleted: (relativePath: string) => void;
}

/**
 * What the tree is showing, and everything that changes its shape.
 *
 * Expansion and the create/rename/delete operations are one unit because they all speak absolute
 * paths against `workspacePath`. Which files are open is the panel's: a rename or a delete is
 * reported back so the tabs can follow it.
 */
export function useFileTreeState({
  connection,
  workspacePath,
  panelOpen,
  isActive,
  selected,
  dirty,
  onOpen,
  onRenamed,
  onDeleted,
}: UseFileTreeStateOptions) {
  const invalidateFileBrowser = useInvalidateFileBrowser();
  const [showHidden, setShowHidden] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileTreeTarget | null>(null);
  /** `null` is the workspace root. Drives the tree highlight and the header's create buttons. */
  const [selectedFolder, setSelectedFolder] = useState<string | null>(() =>
    selected ? folderOf(selected, workspacePath) : null,
  );
  const treeRef = useRef<HTMLDivElement>(null);

  // A folder is highlighted either because the user picked it or because it holds the open file —
  // never because it was picked before an unrelated sibling file was opened. So every selection
  // moves the highlight with it; only clearing the selection leaves it where it was. Adjusted
  // during render: this is state following a changed input.
  const [seenSelected, setSeenSelected] = useState(selected);
  if (seenSelected !== selected) {
    setSeenSelected(selected);
    if (selected != null) setSelectedFolder(folderOf(selected, workspacePath));
  }

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
    void invalidateFileBrowser(connection);
  }, [isActive, invalidateFileBrowser, connection]);

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
    void invalidateFileBrowser(connection);
  }

  function handleTreeAction(action: FileTreeAction) {
    if (action.type === "rename" || action.type === "delete") {
      // Either one closes the file's tab, and its draft with it.
      const at = toSelection(action.target.absolutePath);
      const held = [...dirty].find((p) => p === at || p.startsWith(`${at}/`));
      if (held) {
        toast.error(`Save or discard the changes to ${basename(held)} first.`);
        return;
      }
    }
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
        // Following the rename keeps the open files open rather than blanking their tabs.
        onRenamed(toSelection(target.absolutePath), toSelection(to));
      } else {
        const path = `${nameDialog.parentAbsolutePath}/${name}`;
        if (nameDialog.kind === "new-file") {
          await createFile.mutateAsync({ connection, path });
          onOpen(toSelection(path));
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
      onDeleted(toSelection(deleteTarget.absolutePath));
      setDeleteTarget(null);
    } catch {
      // Reported by the mutation's own error handler.
    }
  }

  return {
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
