import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useAutoMode, useSetAutoMode } from "@/services/settings.service";
import { cn } from "@/lib/utils";

/**
 * Auto vs Manual execution of the Ready queue.
 *
 * Lives on the board rather than in the app header because it only governs what the board does —
 * on the Agents, Worktrees and Settings tabs it is a control with no visible subject.
 *
 * The flag is the project's, kept by its daemon rather than held here, because the scheduler
 * gates on it and drains the queue itself. Setting it pushes `settings-changed` to every window,
 * which refetches the flag.
 */
export function AutoModeToggle({ projectId }: { projectId: number | null }) {
  const { data: autoMode = false, isSuccess } = useAutoMode(projectId);
  const setAutoMode = useSetAutoMode();

  const handleToggle = () => {
    if (projectId === null) return;
    setAutoMode.mutate({ projectId, enabled: !autoMode });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggle}
            disabled={!isSuccess || setAutoMode.isPending}
            className={cn(
              "h-8 gap-1.5 px-2.5 text-xs font-medium",
              autoMode
                ? "bg-green-500/15 text-green-600 dark:text-green-400 hover:bg-green-500/25"
                : "bg-muted/60 text-muted-foreground hover:bg-muted/80",
            )}
          />
        }
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0",
            autoMode ? "bg-green-500 animate-pulse" : "bg-muted-foreground/50",
          )}
        />
        {autoMode ? "Auto" : "Manual"}
      </TooltipTrigger>
      <TooltipContent>
        {autoMode
          ? "Auto mode: tasks in Ready are executed automatically. Click to switch to Manual."
          : "Manual mode: tasks must be started manually. Click to enable Auto mode."}
      </TooltipContent>
    </Tooltip>
  );
}
