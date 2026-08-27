import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useSaveSettings, useSettings } from "@/services/settings.service";
import { cn } from "@/lib/utils.ts";

/**
 * Auto vs Manual execution of the Ready queue.
 *
 * Lives on the board rather than in the app header because it only governs what the board does —
 * on the Agents, Worktrees and Settings tabs it is a control with no visible subject.
 *
 * The flag is read from and written to the settings table rather than held here, because
 * `drain_ready_queue` gates on the stored `auto_mode`. Saving emits `settings-changed`, which
 * `useQueueDrain` listens for — draining here as well would throw the answer away.
 */
export function AutoModeToggle() {
  const { data: appSettings } = useSettings();
  const saveSettings = useSaveSettings({ successToast: false });

  const autoMode = appSettings?.auto_mode ?? false;

  const handleToggle = async () => {
    if (!appSettings) return;
    try {
      await saveSettings.mutateAsync({
        ...appSettings,
        auto_mode: !autoMode,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[auto-mode] failed to persist auto_mode:", err);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggle}
            disabled={!appSettings}
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
