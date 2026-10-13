import { CornerDownRight, Pause, Play, Repeat, Square } from "lucide-react";
import type { Task } from "@/types/bindings";
import { Button } from "@/ui/button";
import {
  useOpenAgentGateMutation,
  usePauseLoopMutation,
  useRerunLoopChecksMutation,
  useStopLoopMutation,
} from "@/services/loop.service";
import { useBoardActions } from "@/store/boardStore";
import { gateLine, loopHalt } from "./loop-state";

/**
 * The loop detail's footer: what the loop's state lets the user do from here. Resuming is the note
 * box's, since a loop that waits on the user is waiting for an answer.
 */
export function LoopActions({
  task,
  onJoin,
  onEditChecks,
}: {
  task: Task;
  onJoin: () => void;
  onEditChecks: () => void;
}) {
  const key = { projectId: task.project_id, taskId: task.id };
  const pause = usePauseLoopMutation();
  const stop = useStopLoopMutation();
  const rerun = useRerunLoopChecksMutation();
  const openGate = useOpenAgentGateMutation();
  const { openReview } = useBoardActions();
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
  const waiting = task.phase_status === "Waiting" && task.ball === "Agent";
  const halt = loopHalt(task);

  if (task.status !== "InProgress" && task.phase !== "Approval") return null;
  return (
    <>
      {gateLine(task) && task.gate && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            openGate.mutate({ projectId: task.project_id, agentId: task.gate!.agent_id })
          }
        >
          <Play className="size-3" />
          Try now
        </Button>
      )}
      {halt === "Flaky" && (
        <>
          <Button size="sm" variant="outline" onClick={onEditChecks}>
            Edit checks
          </Button>
          <Button size="sm" variant="outline" onClick={() => rerun.mutate(key)}>
            <Repeat className="size-3" />
            Re-run checks
          </Button>
        </>
      )}
      {task.phase === "Approval" && (
        <Button size="sm" variant="outline" onClick={() => openReview(task.id)}>
          Review changes
        </Button>
      )}
      {live && task.phase === "Iterating" && (
        <Button size="sm" variant="outline" onClick={onJoin}>
          <CornerDownRight className="size-3" />
          Join
        </Button>
      )}
      {live && !task.loop_summary?.hold && (
        <Button size="sm" variant="outline" onClick={() => pause.mutate(key)}>
          <Pause className="size-3" />
          Pause
        </Button>
      )}
      {(live || waiting) && (
        <Button size="sm" variant="outline" onClick={() => stop.mutate(key)}>
          <Square className="size-3" />
          Stop
        </Button>
      )}
    </>
  );
}
