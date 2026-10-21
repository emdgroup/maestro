import { useState } from "react";
import { CornerDownRight, CirclePause, Play, Repeat } from "lucide-react";
import { toast } from "sonner";
import type { Task } from "@/types/bindings";
import { Button } from "@/ui/button";
import {
  useOpenAgentGateMutation,
  useRerunLoopChecksMutation,
  useResumeLoopMutation,
} from "@/services/loop.service";
import { HaltLoopDialog, haltOptions } from "./HaltLoopDialog";
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
  const [halting, setHalting] = useState(false);
  const rerun = useRerunLoopChecksMutation();
  const resume = useResumeLoopMutation();
  const openGate = useOpenAgentGateMutation();
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
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
      {live && task.phase === "Iterating" && (
        <Button size="sm" variant="outline" onClick={onJoin}>
          <CornerDownRight className="size-3" />
          Join
        </Button>
      )}
      {haltOptions(task).length > 0 && (
        <Button size="sm" variant="outline" onClick={() => setHalting(true)}>
          <CirclePause className="size-3.5 fill-current [&_line]:stroke-background" />
          Halt
        </Button>
      )}
      <HaltLoopDialog task={task} open={halting} onOpenChange={setHalting} />
    </>
  );
}
