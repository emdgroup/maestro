import { CornerDownRight, SquareTerminal } from "lucide-react";
import type { Task } from "@/types/bindings";
import { cn } from "@/lib/utils";
import { useTaskSession } from "@/contexts/BoardActionsContext";
import { useSessionActivity } from "@/store/sessionActivityStore";
import { ACTIVITY_DOT } from "@/components/execution/shared/activityStatus";
import { useLoopChecksQuery, useLoopIterationsQuery } from "@/services/loop.service";

/**
 * Beside the loop: what its agent is doing now, and what the checks said last. The agent gets the
 * same failing output, cut down, and never the sealed files it came from.
 */
export function LoopSidePanel({ task, onJoin }: { task: Task; onJoin: () => void }) {
  const session = useTaskSession(task.id);
  const activity = useSessionActivity(session?.session_id);
  const { data: iterations = [] } = useLoopIterationsQuery(task.project_id, task.id);
  const { data: checks = [] } = useLoopChecksQuery(task.project_id, task.id);
  const running = task.phase === "Iterating" && task.phase_status === "Running";
  const last = [...iterations].reverse().find((i) => i.check_output);
  const failing = checks.filter((c) => c.state === "Fail" || c.state === "Flaky");
  const output =
    last?.check_output ??
    (failing.length > 0
      ? failing.map((c) => `✗ ${c.command ?? c.label}\n${c.detail ?? ""}`).join("\n\n")
      : null);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-1 px-3 py-2">
        <SquareTerminal className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium">{running ? "Live" : "Last check run"}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {running && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    activity ? ACTIVITY_DOT[activity.status] : "animate-pulse bg-success",
                  )}
                />
                Iteration {task.loop_summary?.iteration ?? ""}, now
              </span>
              {session && (
                <button
                  className="flex items-center gap-1 text-accent hover:underline"
                  onClick={onJoin}
                >
                  <CornerDownRight className="size-3" />
                  Join
                </button>
              )}
            </div>
            <div className="rounded-md border border-border bg-background p-2 text-[11px] leading-relaxed">
              {activity?.label ?? "Working"}
            </div>
          </div>
        )}
        {output ? (
          <>
            <pre className="overflow-x-auto whitespace-pre rounded-md border border-border bg-background p-2 font-mono text-[10px] leading-relaxed">
              {output}
            </pre>
            <p className="text-[10px] text-muted-foreground">
              The agent gets the failing part as output only, cut to 200 lines. It never sees the
              sealed files themselves.
            </p>
          </>
        ) : (
          !running && <p className="text-[11px] text-muted-foreground">Nothing has run yet.</p>
        )}
      </div>
    </aside>
  );
}
