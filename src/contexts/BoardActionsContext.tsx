import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useKanban } from "@/contexts/KanbanContext";
import { useExecuteTask } from "@/hooks/useExecuteTask";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useAgentProfilesQuery, useProjectSettings } from "@/services/project.service";
import { DirtyWorktreeDialog } from "@/components/execution/DirtyWorktreeDialog";
import { AgentPickerModal } from "@/components/execution/AgentPickerModal";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";

interface BoardActionsValue {
  execute: ReturnType<typeof useExecuteTask>["execute"];
  /** The task mid-spawn, or `null`. A card compares its own id rather than reading a boolean. */
  executingTaskId: number | null;
  /** Whether any role on this project can run a refinement at all. Project-level, so asked once. */
  canRefine: boolean;
  sessionByTaskId: Map<number, ActiveSessionInfo>;
  worktreeByTaskId: Map<number, WorktreeWithStatus>;
}

const BoardActionsContext = createContext<BoardActionsValue | null>(null);

/**
 * Everything a card needs that is really the board's.
 *
 * Each of these used to be mounted inside `TaskCard`, so a board of N cards held N instances of
 * `useExecuteTask` — itself three queries and five mutations — N subscriptions to the session and
 * worktree lists, and N copies of the two dialogs below, only one of which can ever be open.
 * Nothing here varies per card: the queries share a key, `canRefine` is a property of the project,
 * and the answers are indexed by task id once instead of re-scanned per card per render.
 *
 * The dialogs live here rather than in the card because the state driving them does. `execute`
 * resolves a promise from whichever dialog it opened, so exactly one of each has to be mounted by
 * whoever owns the hook — see the `canPickAgent` note in `useExecuteTask`.
 */
export function BoardActionsProvider({ children }: { children: ReactNode }) {
  const { projectId, projectPath, connection } = useKanban();

  const {
    execute,
    executingTaskId,
    dirtyDialogOpen,
    dirtyModifiedCount,
    dirtyUntrackedCount,
    onDirtyChoice,
    onDirtyCancel,
    agentPickerTask,
    onAgentPicked,
    onAgentPickerCancel,
  } = useExecuteTask(projectId, projectPath, connection);

  const { data: sessions } = useActiveSessionsQuery(projectId ?? undefined);
  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath);
  const { data: profilesDocument } = useAgentProfilesQuery(projectId);
  const defaultAgent = useProjectSettings(projectId).data?.default_agent ?? null;

  // A Refiner profile is how a project opts into refinement; a project default agent is the
  // fallback `useExecuteTask` applies when no profile names one. With neither, there is nothing
  // to start.
  const canRefine =
    (profilesDocument?.profiles ?? []).some((p) => p.role === "Refiner") || !!defaultAgent;

  const sessionByTaskId = useMemo(() => {
    const byTask = new Map<number, ActiveSessionInfo>();
    for (const session of sessions ?? []) {
      if (session.task_id != null) byTask.set(session.task_id, session);
    }
    return byTask;
  }, [sessions]);

  const worktreeByTaskId = useMemo(() => {
    const byTask = new Map<number, WorktreeWithStatus>();
    for (const worktree of worktrees ?? []) {
      if (worktree.task_id != null) byTask.set(worktree.task_id, worktree);
    }
    return byTask;
  }, [worktrees]);

  const value = useMemo(
    () => ({ execute, executingTaskId, canRefine, sessionByTaskId, worktreeByTaskId }),
    [execute, executingTaskId, canRefine, sessionByTaskId, worktreeByTaskId],
  );

  return (
    <BoardActionsContext.Provider value={value}>
      {children}
      <DirtyWorktreeDialog
        open={dirtyDialogOpen}
        modifiedCount={dirtyModifiedCount}
        untrackedCount={dirtyUntrackedCount}
        onChoice={onDirtyChoice}
        onCancel={onDirtyCancel}
      />
      {agentPickerTask && (
        <AgentPickerModal
          open
          task={agentPickerTask}
          proceed={onAgentPicked}
          onClose={onAgentPickerCancel}
        />
      )}
    </BoardActionsContext.Provider>
  );
}

export function useBoardActionsContext(): BoardActionsValue {
  const context = useContext(BoardActionsContext);
  if (!context) {
    throw new Error("useBoardActionsContext must be used within BoardActionsProvider");
  }
  return context;
}

/** The live session a card is showing, if it has one. */
export function useTaskSession(taskId: number): ActiveSessionInfo | null {
  return useBoardActionsContext().sessionByTaskId.get(taskId) ?? null;
}

/** The worktree a task left behind, read by the unmerged-archive confirmation. */
export function useTaskWorktree(taskId: number): WorktreeWithStatus | null {
  return useBoardActionsContext().worktreeByTaskId.get(taskId) ?? null;
}
