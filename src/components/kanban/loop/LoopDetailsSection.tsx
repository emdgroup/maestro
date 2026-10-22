import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Task } from "@/types/bindings";
import {
  useLoopChecksQuery,
  useLoopHiddenFilesQuery,
  useSetLoopChecksMutation,
  useSetLoopHiddenFilesMutation,
} from "@/services/loop.service";
import { useUpdateTask } from "@/services/task.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useSelectedProject } from "@/store/projectStore";
import { LoopTab } from "./LoopTab";
import { emptyLoopDraft, loopDraftFrom, loopFromDraft, type LoopDraft } from "./loop-draft";

export interface LoopDetailsHandle {
  /** Writes what changed. Rejects with what is wrong with the draft. */
  save: () => Promise<void>;
}

/**
 * Whether the loop has started, after which its worktree is sealed to the paths it has. Prepare
 * loop's `Refining` comes before the start.
 */
export const loopStarted = (task: Task) =>
  (task.phase != null && task.phase !== "Refining") ||
  (task.status !== "Planning" && task.status !== "Queue");

/**
 * The loop tab, holding the draft of its checks, hidden files and limits, saved with the rest of
 * the task. Limits and checks change any time; the hidden paths only before the start.
 */
export const LoopDetailsSection = forwardRef<
  LoopDetailsHandle,
  {
    task: Task;
    onDirtyChange: (dirty: boolean) => void;
    onJoin: () => void;
    onPrepare: (() => void) | null;
  }
>(function LoopDetailsSection({ task, onDirtyChange, onJoin, onPrepare }, ref) {
  const key = { projectId: task.project_id, taskId: task.id };
  const { data: checks } = useLoopChecksQuery(task.project_id, task.id);
  const { data: hiddenFiles } = useLoopHiddenFilesQuery(task.project_id, task.id);
  const setChecks = useSetLoopChecksMutation();
  const setHidden = useSetLoopHiddenFilesMutation();
  const updateTask = useUpdateTask();
  // Once the loop has its worktree, its branch is where the hidden paths have to be committed.
  const project = useSelectedProject();
  const { data: worktrees } = useWorktreesQuery(task.project_id, project?.path);
  const branch =
    worktrees?.find((worktree) => worktree.task_id === task.id)?.branch_name ?? task.base_branch;

  const [draft, setDraft] = useState<LoopDraft>(() => ({ ...emptyLoopDraft(), checks: [] }));
  const dirty = useRef(false);

  // From the store until the user edits, as the rest of the modal does.
  useEffect(() => {
    if (!dirty.current && task.loop_config && checks && hiddenFiles) {
      setDraft(loopDraftFrom(task.loop_config, checks, hiddenFiles));
    }
  }, [task.loop_config, checks, hiddenFiles]);

  const save = async () => {
    if (!dirty.current) return;
    const read = loopFromDraft(draft);
    if ("error" in read) throw new Error(read.error);
    await updateTask.mutateAsync({ ...key, updates: { loop_config: read.config } });
    await setChecks.mutateAsync({ ...key, checks: read.checks });
    await setHidden.mutateAsync({ ...key, files: draft.hiddenFiles });
    dirty.current = false;
    onDirtyChange(false);
  };
  useImperativeHandle(ref, () => ({ save }));

  return (
    <LoopTab
      task={task}
      draft={draft}
      onSave={save}
      onDraftChange={(next) => {
        dirty.current = true;
        onDirtyChange(true);
        setDraft(next);
      }}
      baseBranch={branch}
      sealedLocked={loopStarted(task)}
      readOnly={task.status === "Done" || task.status === "Cancelled"}
      onJoin={onJoin}
      onPrepare={onPrepare}
    />
  );
});
