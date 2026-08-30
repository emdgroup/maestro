import { useState, useEffect, useReducer } from "react";
import { RefreshCw, CircleCheck, CircleX, ArrowDownToLine } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Progress, ProgressTrack, ProgressIndicator } from "@/ui/progress";
import { useUpdater } from "@/hooks/useUpdater";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import appIconUrl from "../../../src-tauri/icons/32x32.png?url";

/** Shared with `UpdateStrip`, which shows the same relative time in its tooltip and popover. */
export function formatLastChecked(date: Date | null): string {
  if (!date) return "Never";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return "1 hour ago";
  return `${hours} hours ago`;
}

export function UpdateCard() {
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
  // `lastChecked`. The timer re-renders every 30s and the label is derived below — mirroring
  // it into state only duplicated a value that `formatLastChecked` already computes.
  const [, relabel] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(relabel, 30_000);
    return () => clearInterval(id);
  }, []);
  const lastCheckedLabel = formatLastChecked(lastChecked);

  function handleAutoUpdateToggle(checked: boolean) {
    if (!appSettings) return;
    saveAppSettings.mutate({
      ...appSettings,
      auto_update: checked,
      updated_at: new Date().toISOString(),
    });
  }

  function handleReloadClick() {
    checkForUpdates(autoUpdate);
  }

  const newVersion = status.phase === "available" ? status.version : null;
  const isChecking = status.phase === "checking";

  return (
    <div
      className={`bg-card border rounded-lg p-3 ${
        status.phase === "available" ? "border-accent/25 bg-accent/5" : "border-border"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* App icon */}
        <img src={appIconUrl} alt="Maestro" className="w-9 h-9 rounded-lg shrink-0" />

        {/* Name + version */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">Maestro</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {status.phase === "available" ? (
              <>
                v{appVersion} <span className="text-muted-foreground">→</span>{" "}
                <span className="text-accent font-medium">v{newVersion}</span>
              </>
            ) : (
              <>v{appVersion}</>
            )}
          </div>
        </div>

        {/* Right block — state-dependent */}
        {status.phase === "available" ? (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Button
              size="sm"
              onClick={
                isPackageInstall ? () => void downloadPackage(status.version) : () => void install()
              }
              className="h-7 text-xs gap-1.5 bg-accent text-accent-foreground"
            >
              <ArrowDownToLine className="w-3 h-3" />
              {isPackageInstall ? "Download" : "Install"}
            </Button>
            <span className="text-[10px] font-medium">Update available</span>
          </div>
        ) : status.phase === "downloading" ? (
          <div className="flex flex-col items-end gap-1.5 shrink-0 min-w-25">
            <span className="text-[10px] text-muted-foreground">
              Downloading… {status.progress}%
            </span>
            <Progress value={status.progress} className="block w-24">
              <ProgressTrack className="h-1 bg-muted rounded-full overflow-hidden">
                <ProgressIndicator className="h-full bg-accent rounded-full transition-all" />
              </ProgressTrack>
            </Progress>
          </div>
        ) : (
          /* Up to date / idle / checking / error */
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-center gap-1.5">
                {status.phase === "error" ? (
                  <>
                    <CircleX className="w-3 h-3 text-destructive shrink-0" />
                    <span className="text-[11px] font-semibold text-destructive">Error</span>
                  </>
                ) : (
                  <>
                    <CircleCheck className="w-3 h-3 text-success shrink-0" />
                    <span className="text-[11px] font-semibold text-success">Up to date</span>
                  </>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground/70">
                Last checked: {lastCheckedLabel}
              </span>
            </div>
            <button
              onClick={handleReloadClick}
              disabled={isChecking}
              className="w-8 h-8 rounded-lg border border-border/60 bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              title="Check for updates"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? "animate-spin" : ""}`} />
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-border">
        <span className="text-xs text-muted-foreground">Auto-update</span>
        {isPackageInstall ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
              <Switch
                checked={autoUpdate}
                disabled
                className="data-unchecked:bg-muted data-unchecked:border-border/50 opacity-50 pointer-events-none"
              />
            </TooltipTrigger>
            <TooltipContent side="left">Auto-update requires the AppImage install</TooltipContent>
          </Tooltip>
        ) : (
          <Switch
            checked={autoUpdate}
            onCheckedChange={handleAutoUpdateToggle}
            className="data-unchecked:bg-muted data-unchecked:border-border/50"
          />
        )}
      </div>
    </div>
  );
}
