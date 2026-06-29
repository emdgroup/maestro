import { useState, useEffect } from "react";
import { RefreshCw, CircleCheck, CircleX, ArrowDownToLine } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { useUpdater } from "@/hooks/useUpdater";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import appIconUrl from "../../../src-tauri/icons/32x32.png?url";

function formatLastChecked(date: Date | null): string {
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
  const { status, lastChecked, checkForUpdates, install } = useUpdater();
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });
  const [appVersion, setAppVersion] = useState<string>("…");
  const [lastCheckedLabel, setLastCheckedLabel] = useState(() => formatLastChecked(lastChecked));

  const autoUpdate = appSettings?.auto_update ?? false;

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // Refresh "last checked" label every 30s
  useEffect(() => {
    setLastCheckedLabel(formatLastChecked(lastChecked));
    const id = setInterval(() => setLastCheckedLabel(formatLastChecked(lastChecked)), 30_000);
    return () => clearInterval(id);
  }, [lastChecked]);

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
            <Button size="sm" onClick={install} className="h-7 text-xs gap-1.5 text-accent">
              <ArrowDownToLine className="w-3 h-3" />
              Install
            </Button>
            <span className="text-[10px] font-medium">Update available</span>
          </div>
        ) : status.phase === "downloading" ? (
          <div className="flex flex-col items-end gap-1.5 shrink-0 min-w-25">
            <span className="text-[10px] text-muted-foreground">
              Downloading… {status.progress}%
            </span>
            <div className="w-24 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all"
                style={{ width: `${status.progress}%` }}
              />
            </div>
          </div>
        ) : (
          /* Up to date / idle / checking / error */
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-center gap-1.5">
                {status.phase === "error" ? (
                  <>
                    <CircleX className="w-3 h-3 text-red-500 shrink-0" />
                    <span className="text-[11px] font-semibold text-red-500">Error</span>
                  </>
                ) : (
                  <>
                    <CircleCheck className="w-3 h-3 text-green-500 shrink-0" />
                    <span className="text-[11px] font-semibold text-green-500">Up to date</span>
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
        <Switch
          checked={autoUpdate}
          onCheckedChange={handleAutoUpdateToggle}
          className="data-unchecked:bg-muted data-unchecked:border-border/50"
        />
      </div>
    </div>
  );
}
