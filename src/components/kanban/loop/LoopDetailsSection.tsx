import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Task } from "@/types/bindings";
import {
  useLoopChecksQuery,
  useLoopHiddenFilesQuery,
  useSetLoopChecksMutation,
  useSetLoopHiddenFilesMutation,
} from "@/services/loop.service";
import { useSetTaskProfileOverridesMutation, useUpdateTask } from "@/services/task.service";
import { parseProfileOverrides } from "@/lib/profile-overrides";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useSelectedProject } from "@/store/projectStore";
import { LoopEditor } from "./LoopEditor";
import { emptyLoopDraft, loopDraftFrom, loopFromDraft, type LoopDraft } from "./loop-draft";

export interface LoopDetailsHandle {
  /** Writes what changed. Rejects with what is wrong with the draft. */
  save: () => Promise<void>;
}

/** Whether the loop has started, after which its worktree is sealed to the paths it has. */
export const loopStarted = (task: Task) =>
  task.phase != null || (task.status !== "Planning" && task.status !== "Queue");

/**
 * A loop's checks, sealed files and budget on its Details tab, saved with the rest of the task.
 * Budgets and checks change any time; the sealed paths only before the start.
 */
export const LoopDetailsSection = forwardRef<
  LoopDetailsHandle,
  { task: Task; onDirtyChange: (dirty: boolean) => void }
>(function LoopDetailsSection({ task, onDirtyChange }, ref) {
  const key = { projectId: task.project_id, taskId: task.id };
  const { data: checks } = useLoopChecksQuery(task.project_id, task.id);
  const { data: hiddenFiles } = useLoopHiddenFilesQuery(task.project_id, task.id);
  const setChecks = useSetLoopChecksMutation();
  const setHidden = useSetLoopHiddenFilesMutation();
  const updateTask = useUpdateTask();
  const setOverrides = useSetTaskProfileOverridesMutation();
  const overrides = parseProfileOverrides(task.profile_overrides);
  const storedJudge = overrides.Judge ?? null;
  // Once the loop has its worktree, its branch is where the sealed paths have to be committed.
  const project = useSelectedProject();
  const { data: worktrees } = useWorktreesQuery(task.project_id, project?.path);
  const branch =
    worktrees?.find((worktree) => worktree.task_id === task.id)?.branch_name ?? task.base_branch;

  const [draft, setDraft] = useState<LoopDraft>(emptyLoopDraft);
  const dirty = useRef(false);

  // From the store until the user edits, as the rest of the modal does.
  useEffect(() => {
    if (!dirty.current && task.loop_config && checks && hiddenFiles) {
      setDraft(loopDraftFrom(task.loop_config, checks, hiddenFiles, storedJudge));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.loop_config, checks, hiddenFiles, storedJudge]);

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!dirty.current) return;
      const read = loopFromDraft(draft);
      if ("error" in read) throw new Error(read.error);
      await updateTask.mutateAsync({ ...key, updates: { loop_config: read.config } });
      await setChecks.mutateAsync({ ...key, checks: read.checks });
      await setHidden.mutateAsync({ ...key, files: draft.hiddenFiles });
      if (draft.judgeProfileId !== storedJudge) {
        const next = { ...overrides };
        if (draft.judgeProfileId) next.Judge = draft.judgeProfileId;
        else delete next.Judge;
        await setOverrides.mutateAsync({ ...key, overrides: next });
      }
      dirty.current = false;
      onDirtyChange(false);
    },
  }));

  return (
    <div className="shrink-0 space-y-2 border-t border-border pt-3">
      <span className="text-xs font-medium">The loop</span>
      <LoopEditor
        value={draft}
        onChange={(next) => {
          dirty.current = true;
          onDirtyChange(true);
          setDraft(next);
        }}
        projectId={task.project_id}
        baseBranch={branch}
        sealedLocked={loopStarted(task)}
        readOnly={task.status === "Done" || task.status === "Cancelled"}
      />
    </div>
  );
});
