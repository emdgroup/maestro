import { open as openDirPicker } from "@tauri-apps/plugin-dialog";
import { ScrollText } from "lucide-react";
import { api } from "@/lib/tauri-utils";
import {
  useLogDirectory,
  useLogLevels,
  useSaveSettings,
  useSettings,
} from "@/services/settings.service";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";

const DEFAULT_LOG_LEVEL = "info";

/**
 * `trace` is called out because it is the level that writes prompt text, agent output and the
 * contents of files the agent read into the log file. A user who is about to attach that file to a
 * bug report should know before they turn it on, not after.
 */
const LEVEL_DESCRIPTIONS: Record<string, string> = {
  error: "Failures only",
  warn: "Failures and recoverable problems",
  info: "Recommended — startup and problems",
  debug: "Adds session and connection detail",
  trace: "Everything, including prompts and agent output",
};

export function DiagnosticsSection() {
  const { data: appSettings } = useSettings();
  const { data: logLevels } = useLogLevels();
  const { data: logLocation } = useLogDirectory();
  const saveAppSettings = useSaveSettings({ successToast: false });

  const logLevel = appSettings?.log_level ?? DEFAULT_LOG_LEVEL;
  const isCustomDirectory = Boolean(appSettings?.log_directory);
  // The running logger keeps writing to the directory it opened at launch.
  const needsRestart =
    logLocation != null &&
    logLocation.active_directory !== "" &&
    logLocation.active_directory !== logLocation.configured_directory;

  function updateSettings(changes: { log_level?: string | null; log_directory?: string | null }) {
    if (!appSettings) return;
    saveAppSettings.mutate({
      ...appSettings,
      ...changes,
      updated_at: new Date().toISOString(),
    });
  }

  async function handleChooseDirectory() {
    const selected = await openDirPicker({
      directory: true,
      multiple: false,
      title: "Choose a folder for Maestro logs",
    });
    if (typeof selected === "string") {
      updateSettings({ log_directory: selected });
    }
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <ScrollText className="w-4 h-4 text-muted-foreground" />
        Diagnostics
      </h3>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Log Level</Label>
        <Select
          value={logLevel}
          onValueChange={(value: string | null) => {
            if (value) updateSettings({ log_level: value });
          }}
        >
          <SelectTrigger className="w-full bg-muted">
            <SelectValue>{LEVEL_DESCRIPTIONS[logLevel] ?? logLevel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(logLevels ?? [DEFAULT_LOG_LEVEL]).map((level) => (
              <SelectItem key={level} value={level}>
                {level} — {LEVEL_DESCRIPTIONS[level] ?? ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Applies immediately. Raising this above <span className="font-medium">info</span> makes
          the log much larger; <span className="font-medium">trace</span> records prompts and agent
          output.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Log Location</Label>
        <p className="text-xs font-mono break-all text-foreground bg-muted rounded-md px-2 py-1.5">
          {logLocation?.active_directory || logLocation?.configured_directory || "Unavailable"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!logLocation?.active_directory}
            onClick={() => {
              if (logLocation?.active_directory) {
                void api.openPathNative(logLocation.active_directory);
              }
            }}
          >
            Open Folder
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleChooseDirectory()}
          >
            Change…
          </Button>
          {isCustomDirectory && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => updateSettings({ log_directory: null })}
            >
              Reset to Default
            </Button>
          )}
        </div>
        {needsRestart ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Restart Maestro to start writing to {logLocation?.configured_directory}. Until then the
            path above is where logs are going.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Attach <span className="font-mono">Maestro.log</span> from this folder to a bug report.
            Changing the folder takes effect on the next launch.
          </p>
        )}
      </div>
    </div>
  );
}
