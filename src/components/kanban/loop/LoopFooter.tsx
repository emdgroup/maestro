import type { Task } from "@/types/bindings";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { BotMessageSquare, OctagonPause, Play, RotateCw } from "lucide-react";
import { haltOptions } from "./HaltLoopDialog";
import { loopHalt } from "./loop-state";

export interface LoopFooterActions {
  /** Asks how to halt it: once the running step ends, or now. */
  onHalt: () => void;
  onResume: () => void;
  onRerunChecks: () => void;
}

/**
 * The controls of a loop in progress. Halt asks whether to wait for the running step or cut it,
 * and the worktree, the iterations and the checks stay either way. The decisions a halted loop asks for (a note,
 * an edited check) are in its detail; the card offers the one move that needs none.
 */
export function LoopFooter({
  task,
  hasActiveSession,
  className,
  actions,
}: {
  task: Task;
  hasActiveSession: boolean;
  className: string;
  actions: LoopFooterActions & { onJoin: () => void };
}) {
  const button = (label: string, icon: React.ReactNode, onClick: () => void, extra?: string) => (
    <Button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      variant="ghost"
      className={cn(className, "h-auto", extra)}
    >
      {icon}
      {label}
    </Button>
  );
  const halt = loopHalt(task);
  if (halt === "Flaky") {
    return (
      <div className="flex gap-1 mt-1.5">
        {button("Re-run checks", <RotateCw className="w-2.5 h-2.5" />, actions.onRerunChecks)}
      </div>
    );
  }
  if (halt) {
    return (
      <div className="flex gap-1 mt-1.5">
        {button("Resume", <Play className="w-2.5 h-2.5 fill-current" />, actions.onResume)}
      </div>
    );
  }
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
  const waiting = task.phase_status === "Waiting" && task.ball === "Agent";
  if (!live && !waiting) return null;
  const canHalt = haltOptions(task).length > 0;
  return (
    <div className="flex gap-1 mt-1.5">
      {canHalt &&
        button(
          "Halt",
          <OctagonPause className="w-2.5 h-2.5" />,
          actions.onHalt,
          "bg-foreground text-background",
        )}
      {hasActiveSession &&
        button("Join", <BotMessageSquare className="w-2.5 h-2.5" />, actions.onJoin)}
    </div>
  );
}
