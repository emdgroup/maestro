import { CornerDownRight, Pause, Play, Repeat, Square } from "lucide-react";
import { toast } from "sonner";
import type { Task } from "@/types/bindings";
import { Button } from "@/ui/button";
import {
  useOpenAgentGateMutation,
  usePauseLoopMutation,
  useRerunLoopChecksMutation,
  useResumeLoopMutation,
  useStopLoopMutation,
} from "@/services/loop.service";
import { useBoardActions } from "@/store/boardStore";
import { gateLine, loopHalt } from "./loop-state";

/**
 * The loop detail's footer: what the loop's state lets the user do from here. Resume goes on with
 * no note; answering the loop with one is the note box's.
 */
export function LoopActions({
  task,
  onJoin,
  beforeResume,
}: {
  task: Task;
  onJoin: () => void;
  /** Saves the loop tab's edits, so a resumed loop runs on them. Rejects with what is wrong. */
  beforeResume: () => Promise<void>;
}) {
  const key = { projectId: task.project_id, taskId: task.id };
  const pause = usePauseLoopMutation();
  const stop = useStopLoopMutation();
  const rerun = useRerunLoopChecksMutation();
  const resume = useResumeLoopMutation();
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
        <Button size="sm" variant="outline" onClick={() => rerun.mutate(key)}>
          <Repeat className="size-3" />
          Re-run checks
        </Button>
      )}
      {halt && halt !== "Flaky" && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await beforeResume();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e));
              return;
            }
            resume.mutate({ ...key, note: null });
          }}
        >
          <Play className="size-3" />
          Resume
        </Button>
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
