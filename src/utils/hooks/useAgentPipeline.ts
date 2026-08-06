import { useEffect, useRef } from "react";
import type { AgentRole, Task } from "@/types/bindings";
import { useExecuteTask } from "@/utils/hooks/useExecuteTask";

/// Collapses the burst of events one transition produces — a turn ending emits `tasks-changed`
/// more than once — so a handoff is started from the settled state rather than a partial one.
const DEBOUNCE_MS = 400;

/**
 * Starts the agent the board is asking for when one role hands work to another.
 *
 * The signal is `phase_status: "Waiting"` with the ball on `Agent`, which is a combination nothing
 * else produces: a gate waiting on a person has the ball on `User`, and a running agent is
 * `Running`. Rust decides *whether* a role should run — it is the side that knows the project's
 * profiles and the round count — and this hook does the starting, because starting means a
 * worktree, a session and a prompt, which all live in `useExecuteTask`.
 *
 * Only two handoffs exist, and both have a human at the end of them: a coder finishing hands to
 * the reviewer, and a reviewer asking for changes hands back to the coder. The loop is bounded in
 * `reader_task.rs` at `REVIEW_ROUND_CAP` rounds, after which the task goes to the human gate with
 * the findings intact — this hook has no cap of its own and must not be the thing that stops it.
 */
export function useAgentPipeline(
  projectId: number | null,
  projectPath: string,
  tasks: Task[],
  connection: Parameters<typeof useExecuteTask>[2],
) {
  const { execute } = useExecuteTask(projectId, projectPath, connection);

  const executeRef = useRef(execute);
  executeRef.current = execute;

  /// Ids already handed to `execute` this session. The task's state does not change until the
  /// session is up, so without this the debounce window would start the same agent twice.
  const startedRef = useRef(new Set<number>());

  useEffect(() => {
    if (!projectId) return;

    const pending: Array<[Task, AgentRole]> = tasks.flatMap((task) => {
      if (task.phase_status !== "Waiting" || task.ball !== "Agent") return [];
      if (task.phase === "SelfReview") return [[task, "Reviewer" as AgentRole]];
      if (task.phase === "Rework") return [[task, "Coder" as AgentRole]];
      return [];
    });

    // Anything no longer pending has moved on, so its guard can be dropped — that is what lets a
    // second review round start after the first one finished.
    for (const id of startedRef.current) {
      if (!pending.some(([task]) => task.id === id)) startedRef.current.delete(id);
    }

    const due = pending.filter(([task]) => !startedRef.current.has(task.id));
    if (due.length === 0) return;

    const timer = setTimeout(() => {
      for (const [task, role] of due) {
        startedRef.current.add(task.id);
        void executeRef.current(task, { role });
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [projectId, tasks]);
}
