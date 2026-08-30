import { useState, useEffect, useReducer } from "react";
import { RefreshCw, CircleCheck, CircleX, ArrowDownToLine, ChevronDown } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Progress, ProgressTrack, ProgressIndicator } from "@/ui/progress";
import { useUpdater } from "@/hooks/useUpdater";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import { cn } from "@/lib/utils";
import { formatLastChecked } from "./UpdateCard";
import appIconUrl from "../../../src-tauri/icons/32x32.png?url";

/**
 * The settings surface's header bar: what this app is, and whether it is current.
 *
 * A strip rather than a page, because "am I up to date" is a status the user wants answered on
 * arrival, not one they should have to navigate to. The auto-update switch — the only thing
 * here that is actually a setting — moves into the popover on the right, so the bar stays one
 * line. `UpdateCard` still exists for the welcome screen's version badge, which has room for
 * the tall form.
 */
export function UpdateStrip({ padEnd = false }: { padEnd?: boolean }) {
  const { status, lastChecked, isPackageInstall, checkForUpdates, install, downloadPackage } =
    useUpdater();
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });
  const [appVersion, setAppVersion] = useState<string>("…");

  const autoUpdate = appSettings?.auto_update ?? false;

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // The label is relative to the wall clock, so what goes stale is the current time, not
  // `lastChecked`. The timer re-renders every 30s and the label is derived below.
  const [, relabel] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(relabel, 30_000);
    return () => clearInterval(id);
  }, []);

  function handleAutoUpdateToggle(checked: boolean) {
    if (!appSettings) return;
    saveAppSettings.mutate({
      ...appSettings,
      auto_update: checked,
      updated_at: new Date().toISOString(),
    });
  }

  const newVersion = status.phase === "available" ? status.version : null;
  const isChecking = status.phase === "checking";

  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-3 bg-card pl-4 pr-4",
        // A host that overlays its own control in this corner — the picker's dialog puts its
        // close button there — needs the bar to stop short of it.
        padEnd && "pr-14",
      )}
    >
      <img src={appIconUrl} alt="" className="size-6 shrink-0 rounded-md" />

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-sm font-semibold">Maestro</span>
        <span className="truncate text-xs text-muted-foreground">
          {status.phase === "available" ? (
            <>
              v{appVersion} <span aria-hidden>→</span>{" "}
              <span className="font-medium text-accent">v{newVersion}</span>
            </>
          ) : (
            <>v{appVersion}</>
          )}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {status.phase === "available" ? (
          <Button
            size="sm"
            onClick={
              isPackageInstall ? () => void downloadPackage(status.version) : () => void install()
            }
            className="h-7 gap-1.5 bg-accent text-xs text-accent-foreground"
          >
            <ArrowDownToLine className="size-3" />
            {isPackageInstall ? "Download" : "Install"}
          </Button>
        ) : status.phase === "downloading" ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              Downloading… {status.progress}%
            </span>
            <Progress value={status.progress} className="block w-24">
              <ProgressTrack className="h-1 overflow-hidden rounded-full bg-muted">
                <ProgressIndicator className="h-full rounded-full bg-accent transition-all" />
              </ProgressTrack>
            </Progress>
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<span className="flex cursor-default items-center gap-1.5" />}
              aria-label={status.phase === "error" ? "Update check failed" : "Up to date"}
            >
              {status.phase === "error" ? (
                <>
                  <CircleX className="size-3 shrink-0 text-destructive" />
                  <span className="text-[11px] font-semibold text-destructive">Error</span>
                </>
              ) : (
                <>
                  <CircleCheck className="size-3 shrink-0 text-success" />
                  <span className="text-[11px] font-semibold text-success">Up to date</span>
                </>
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Last checked: {formatLastChecked(lastChecked)}
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => checkForUpdates(autoUpdate)}
                disabled={isChecking}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                aria-label="Check for updates"
              />
            }
          >
            <RefreshCw className={cn("size-3.5", isChecking && "animate-spin")} />
          </TooltipTrigger>
          <TooltipContent side="bottom">Check for updates</TooltipContent>
        </Tooltip>

        <Popover>
          <PopoverTrigger
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Update settings"
          >
            <ChevronDown className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 gap-3 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">Auto-update</p>
                <p className="text-[11px] text-muted-foreground">
                  {isPackageInstall
                    ? "Requires the AppImage install"
                    : "Download and install new versions on launch"}
                </p>
              </div>
              <Switch
                checked={autoUpdate}
                disabled={isPackageInstall}
                onCheckedChange={handleAutoUpdateToggle}
                className={cn(
                  "data-unchecked:border-border/50 data-unchecked:bg-muted",
                  isPackageInstall && "pointer-events-none opacity-50",
                )}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Last checked: {formatLastChecked(lastChecked)}
            </p>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
