import { open as openDirPicker } from "@tauri-apps/plugin-dialog";
import {
  Bug,
  CircleAlert,
  ExternalLink,
  FolderOpen,
  Info,
  Microscope,
  RotateCcw,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "@/lib/tauri-utils";
import {
  useLogDirectory,
  useLogLevels,
  useSaveSettings,
  useSettings,
} from "@/services/settings.service";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

const DEFAULT_LOG_LEVEL = "info";

/**
 * Each level as its own row, so the description reads as a sentence rather than as a tail on the
 * level's name. The shape follows `WorkspaceModeSelect`, which is the other place a setting is
 * picked by what it does rather than by what it is called.
 *
 * `trace` is called out because it is the level that writes prompt text, agent output and the
 * contents of files the agent read into the log file. A user who is about to attach that file to a
 * bug report should know before they turn it on, not after.
 */
const LEVELS: Record<string, { description: string; icon: LucideIcon }> = {
  error: { description: "Failures only", icon: CircleAlert },
  warn: { description: "Failures and recoverable problems", icon: TriangleAlert },
  info: { description: "Recommended. Startup and problems", icon: Info },
  debug: { description: "Adds session and connection detail", icon: Bug },
  trace: { description: "Everything, including prompts and agent output", icon: Microscope },
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

  const activeDirectory = logLocation?.active_directory ?? "";
  const shownDirectory = activeDirectory || logLocation?.configured_directory || "Unavailable";
  const SelectedIcon = LEVELS[logLevel]?.icon ?? Info;

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

      <div className="space-y-2">
        <Label htmlFor="log-level" className="text-sm font-medium">
          Log level
        </Label>
        <Select
          value={logLevel}
          onValueChange={(value: string | null) => {
            if (value) updateSettings({ log_level: value });
          }}
        >
          {/* `data-[size=default]:h-auto` rather than `h-auto`: the trigger's own height is set
              under that variant, which outranks a plain utility, so an unqualified `h-auto`
              leaves the two-line content overflowing a 36px box. */}
          <SelectTrigger
            id="log-level"
            className="w-full data-[size=default]:h-auto py-2 px-3 border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
          >
            <span className="flex items-center gap-2 min-w-0 flex-1 text-left">
              <SelectedIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate">{logLevel}</span>
                <span className="block text-xs text-muted-foreground truncate">
                  {LEVELS[logLevel]?.description ?? ""}
                </span>
              </span>
            </span>
          </SelectTrigger>
          <SelectContent>
            {(logLevels ?? [DEFAULT_LOG_LEVEL]).map((level) => {
              const Icon = LEVELS[level]?.icon ?? Info;
              return (
                <SelectItem key={level} value={level} className="py-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm">{level}</span>
                      <span className="block text-xs text-muted-foreground">
                        {LEVELS[level]?.description ?? ""}
                      </span>
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Applies immediately. Raising this above <span className="font-medium">info</span> makes
          the log much larger, and <span className="font-medium">trace</span> records prompts and
          agent output.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="log-location" className="text-sm font-medium">
          Log location
        </Label>
        {/* The path and everything you can do to it in one control, rather than a paragraph with
            a row of buttons under it. The buttons lose their labels to fit, so each carries a
            tooltip and an `aria-label`. */}
        <InputGroup>
          <InputGroupInput
            id="log-location"
            readOnly
            value={shownDirectory}
            className="font-mono text-xs"
          />
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Open the log folder"
                    disabled={!activeDirectory}
                    onClick={() => {
                      if (activeDirectory) void api.openPathNative(activeDirectory);
                    }}
                  />
                }
              >
                <ExternalLink />
              </TooltipTrigger>
              <TooltipContent>Open in file explorer</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Choose a different log folder"
                    onClick={() => void handleChooseDirectory()}
                  />
                }
              >
                <FolderOpen />
              </TooltipTrigger>
              <TooltipContent>Change folder</TooltipContent>
            </Tooltip>

            {isCustomDirectory && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Reset the log folder to the default"
                      onClick={() => updateSettings({ log_directory: null })}
                    />
                  }
                >
                  <RotateCcw />
                </TooltipTrigger>
                <TooltipContent>Reset to default</TooltipContent>
              </Tooltip>
            )}
          </InputGroupAddon>
        </InputGroup>
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
