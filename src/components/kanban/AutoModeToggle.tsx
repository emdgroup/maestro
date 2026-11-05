import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useAutoMode, useSetAutoMode } from "@/services/settings.service";

/**
 * Auto vs Manual execution of the Ready queue.
 *
 * Lives on the board rather than in the app header because it only governs what the board does —
 * on the Agents, Worktrees and Settings tabs it is a control with no visible subject.
 *
 * A switch rather than a pill: it sits beside the board's filters but, unlike them, changes what
 * the scheduler does, so it must not look like one more filter.
 *
 * The flag is the project's, kept by its daemon rather than held here, because the scheduler
 * gates on it and drains the queue itself. Setting it pushes `settings-changed` to every window,
 * which refetches the flag.
 */
export function AutoModeToggle({ projectId }: { projectId: number | null }) {
  const { data: autoMode = false, isSuccess } = useAutoMode(projectId);
  const setAutoMode = useSetAutoMode();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label className="flex h-6 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs font-medium select-none hover:bg-foreground/6" />
        }
      >
        Auto-run
        <Switch
          size="sm"
          checked={autoMode}
          onCheckedChange={(enabled) => {
            if (projectId !== null) setAutoMode.mutate({ projectId, enabled });
          }}
          disabled={!isSuccess || setAutoMode.isPending}
          className="data-checked:bg-green-500 data-unchecked:bg-muted data-unchecked:border-border/50"
        />
      </TooltipTrigger>
      <TooltipContent>
        {autoMode
          ? "Tasks in Ready start on their own. Switch off to start them by hand."
          : "Tasks in Ready wait for you to start them. Switch on to start them automatically."}
      </TooltipContent>
    </Tooltip>
  );
}
