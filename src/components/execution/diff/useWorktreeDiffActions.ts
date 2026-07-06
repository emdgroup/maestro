import type { Dispatch, SetStateAction } from "react";
import { extractHunkPatch } from "@/lib/diff-utils";
import type { DiffFileWithName } from "@/types/review";
import type {
  useStageWorktreeFilesMutation,
  useCommitWorktreeMutation,
  useDiscardWorktreeChangesMutation,
  useShelveWorktreeChangesMutation,
  useDeleteUntrackedFilesMutation,
} from "@/services/worktree.service";

interface WorktreeDiffActionsParams {
  projectId: number | null;
  worktreePath: string | null;
  stagedFiles: Set<string>;
  setStagedFiles: Dispatch<SetStateAction<Set<string>>>;
  stagedHunks: Map<string, Set<number>>;
  setStagedHunks: Dispatch<SetStateAction<Map<string, Set<number>>>>;
  diffFiles: DiffFileWithName[];
  commitMessage: string;
  setCommitMessage: Dispatch<SetStateAction<string>>;
  shelveName: string;
  setShelvePopoverOpen: Dispatch<SetStateAction<boolean>>;
  setDiscardDialogOpen: Dispatch<SetStateAction<boolean>>;
  setDeleteDialogOpen: Dispatch<SetStateAction<boolean>>;
  stageMutation: ReturnType<typeof useStageWorktreeFilesMutation>;
  commitMutation: ReturnType<typeof useCommitWorktreeMutation>;
  discardMutation: ReturnType<typeof useDiscardWorktreeChangesMutation>;
  shelveMutation: ReturnType<typeof useShelveWorktreeChangesMutation>;
  deleteMutation: ReturnType<typeof useDeleteUntrackedFilesMutation>;
  onClose: () => void;
}

export function useWorktreeDiffActions({
  projectId,
  worktreePath,
  stagedFiles,
  setStagedFiles,
  stagedHunks,
  setStagedHunks,
  diffFiles,
  commitMessage,
  setCommitMessage,
  shelveName,
  setShelvePopoverOpen,
  setDiscardDialogOpen,
  setDeleteDialogOpen,
  stageMutation,
  commitMutation,
  discardMutation,
  shelveMutation,
  deleteMutation,
  onClose,
}: WorktreeDiffActionsParams) {
  async function handleRevert() {
    if (!projectId || !worktreePath) return;

    const filePathsToRevert = [...stagedFiles];

    const patchParts: string[] = [];
    for (const [fileName, hunkIndices] of stagedHunks) {
      if (stagedFiles.has(fileName)) continue;
      const file = diffFiles.find((f) => f.fileName === fileName);
      if (!file) continue;
      for (const idx of hunkIndices) {
        const patch = extractHunkPatch(file.hunks[0] ?? "", idx);
        if (patch) patchParts.push(patch);
      }
    }
    const combinedPatch = patchParts.length > 0 ? patchParts.join("") : null;

    try {
      await discardMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: filePathsToRevert,
        patch: combinedPatch,
      });
      setStagedFiles(new Set());
      setStagedHunks(new Map());
      setDiscardDialogOpen(false);
    } catch {
      // error toast handled by mutation
    }
  }

  async function handleShelve() {
    if (!projectId || !worktreePath || !shelveName.trim()) return;

    const filePaths = [
      ...stagedFiles,
      ...[...stagedHunks.keys()].filter((f) => !stagedFiles.has(f)),
    ];

    try {
      await shelveMutation.mutateAsync({
        projectId,
        worktreePath,
        stashName: shelveName.trim(),
        filePaths,
      });
      setStagedFiles(new Set());
      setStagedHunks(new Map());
      setShelvePopoverOpen(false);
    } catch {
      // error toast handled by mutation
    }
  }

  async function handleCommit() {
    if (!projectId || !worktreePath || !commitMessage.trim()) return;

    const filesToStage = [...stagedFiles];
    const patchParts: string[] = [];
    for (const [fileName, hunkIndices] of stagedHunks) {
      if (stagedFiles.has(fileName)) continue;
      const file = diffFiles.find((f) => f.fileName === fileName);
      if (!file) continue;
      for (const idx of hunkIndices) {
        const patch = extractHunkPatch(file.hunks[0] ?? "", idx);
        if (patch) patchParts.push(patch);
      }
    }
    const combinedPatch = patchParts.length > 0 ? patchParts.join("") : null;

    try {
      await stageMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: filesToStage,
        patch: combinedPatch,
      });
      await commitMutation.mutateAsync({
        projectId,
        worktreePath,
        message: commitMessage.trim(),
      });

      setStagedFiles(new Set());
      setStagedHunks(new Map());
      setCommitMessage("");

      const allFilesStaged = filesToStage.length === diffFiles.length && !combinedPatch;
      if (allFilesStaged) {
        onClose();
      }
    } catch {
      // errors handled by mutation onError toasts
    }
  }

  async function handleStageUntracked() {
    if (!projectId || !worktreePath) return;
    try {
      await stageMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: [...stagedFiles],
        patch: null,
      });
      setStagedFiles(new Set());
    } catch {
      // error toast handled by mutation
    }
  }

  async function handleDeleteUntracked() {
    if (!projectId || !worktreePath || stagedFiles.size === 0) return;
    try {
      await deleteMutation.mutateAsync({
        projectId,
        worktreePath,
        filePaths: [...stagedFiles],
      });
      setStagedFiles(new Set());
      setDeleteDialogOpen(false);
    } catch {
      // keep dialog open; error surfaced via deleteMutation.error
    }
  }

  return { handleRevert, handleShelve, handleCommit, handleStageUntracked, handleDeleteUntracked };
}
