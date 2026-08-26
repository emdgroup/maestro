import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import type { Task } from "@/types/bindings";
import { useExecuteTask } from "@/utils/hooks/useExecuteTask";

/// Long enough to collapse the burst of events one transition produces — a turn ending emits
/// `tasks-changed` and `sessions-changed` together — and short enough that a freed slot is filled
/// while the user is still looking at the board.
const DEBOUNCE_MS = 400;

/**
 * Starts the tasks the backend's scheduler picks.
 *
 * The decision and the execution are deliberately split. Only Rust can decide *which* tasks run:
 * the limit is per host, and a host serves every project pointed at it, which the frontend cannot
 * see because it has one project loaded. But only the frontend can *start* one, because starting
 * means resolving a worktree, spawning an ACP session and sending a prompt — all of which live in
 * `useExecuteTask`. So Rust answers "these ids", and this hook runs them.
 *
 * `drain_ready_queue` was previously called in one place, when auto-mode was switched on, and its
 * answer was thrown away. That made auto-mode a switch that did nothing: it never fired when a
 * slot actually freed, and would not have started anything if it had.
 */
export function useQueueDrain(
  projectId: number | null,
  projectPath: string,
  tasks: Task[],
  connection: Parameters<typeof useExecuteTask>[2],
) {
  const { execute } = useExecuteTask(projectId, projectPath, connection);

  // Read through refs so the listeners below are registered once per project rather than being
  // torn down and rebuilt on every task update — which, since a drain causes a task update, would
  // mean re-subscribing in the middle of the work the subscription triggered.
  //
  // Mirrored from an effect rather than assigned during render — only `drain` reads them, and it
  // runs from a debounced timer or an event listener, never while rendering.
  const tasksRef = useRef(tasks);
  const executeRef = useRef(execute);
  useEffect(() => {
    tasksRef.current = tasks;
    executeRef.current = execute;
  });

  /// Guards against overlapping drains. Two in flight would each be told the same slots are free,
  /// since the first one's claims are not written until its spawns begin.
  const drainingRef = useRef(false);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const drain = async () => {
      if (cancelled || drainingRef.current) return;
      drainingRef.current = true;
      try {
        const taskIds = await api.drainReadyQueue(projectId, projectPath);
        for (const taskId of taskIds) {
          if (cancelled) return;
          const task = tasksRef.current.find((t) => t.id === taskId);
          // The list can lag the backend by a render. Skipping is safe — the task keeps its place
          // in the queue and the next drain picks it up.
          if (!task) continue;
          // Sequentially, because each start claims a slot and the ids were counted against the
          // slots free when the drain ran. Firing them at once would be correct only until a
          // claim failed, and then it would be over the limit.
          await executeRef.current(task);
        }
      } catch (err) {
        console.error("[auto-mode] queue drain failed:", err);
      } finally {
        drainingRef.current = false;
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void drain(), DEBOUNCE_MS);
    };

    // Startup counts as a trigger. A queue left full when the app closed would otherwise sit there
    // until something else happened to move a task.
    schedule();

    // Every event that can free a slot or add a candidate: a session ending, a review approved, a
    // task dragged into Queue, auto-mode switched on.
    //
    // `task-hold-released` is the odd one out and has to be here: a drag that ends where it
    // started changes nothing, so it emits no `tasks-changed`, and the task it was skipped from
    // would otherwise wait for something unrelated to move the board.
    const unlisteners = [
      "tasks-changed",
      "sessions-changed",
      "settings-changed",
      "task-hold-released",
    ].map((event) => listen(event, schedule));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const unlisten of unlisteners) {
        void unlisten.then((fn) => fn());
      }
    };
  }, [projectId, projectPath]);
}
