import { RefreshCw, CircleCheck, CircleX, ArrowDownToLine, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Progress, ProgressTrack, ProgressIndicator } from "@/ui/progress";
import { cn } from "@/lib/utils";
import { useUpdatePanel } from "./useUpdatePanel";
import appIconUrl from "../../../src-tauri/icons/32x32.png?url";

/**
 * A version number that opens its GitHub release, whose body release-please fills with that
 * version's changelog. Plain text until `getVersion` resolves, so nothing links to `v…`.
 */
export function VersionLink({
  version,
  label,
  icon = true,
  className,
}: {
  version: string;
  label: string;
  icon?: boolean;
  className?: string;
}) {
  if (version === "…") return <>v{version}</>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() =>
              void openUrl(`https://github.com/emdgroup/maestro/releases/tag/v${version}`)
            }
            className={cn(
              "group inline-flex cursor-pointer items-center gap-0.5 underline-offset-2 hover:underline",
              className,
            )}
          />
        }
      >
        v{version}
        {icon && (
          <ExternalLink className="size-2.5 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function UpdateCard() {
  const {
    status,
    isPackageInstall,
    checkForUpdates,
    install,
    downloadPackage,
    appVersion,
    autoUpdate,
    setAutoUpdate,
    lastCheckedLabel,
    isChecking,
  } = useUpdatePanel();

  return (
    // Shaped like a Home tile but opaque and still, so it reads apart from the glass around it.
    // An available update takes the accent border.
    <div
      className={cn(
        "rounded-2xl border bg-card p-4",
        status.phase === "available" ? "border-accent/50" : "border-foreground/[0.07]",
      )}
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
                <VersionLink
                  version={appVersion}
                  label={`View v${appVersion} changelog on GitHub`}
                  icon={false}
                  className="hover:text-foreground"
                />{" "}
                <span className="text-muted-foreground">→</span>{" "}
                <VersionLink
                  version={status.version}
                  label={`What's new in v${status.version}`}
                  className="text-accent font-medium"
                />
              </>
            ) : (
              <VersionLink
                version={appVersion}
                label={`View v${appVersion} changelog on GitHub`}
                className="hover:text-foreground"
              />
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
              className="h-7 text-xs gap-1.5"
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    onClick={() => checkForUpdates(autoUpdate)}
                    disabled={isChecking}
                    aria-label="Check for updates"
                    className="w-8 h-8 rounded-lg border border-border/60 bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/7 transition-colors disabled:opacity-50"
                  />
                }
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? "animate-spin" : ""}`} />
              </TooltipTrigger>
              <TooltipContent>Check for updates</TooltipContent>
            </Tooltip>
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
            onCheckedChange={setAutoUpdate}
            className="data-unchecked:bg-muted data-unchecked:border-border/50"
          />
        )}
      </div>
    </div>
  );
}
