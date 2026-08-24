import { useSettings, useSaveSettings } from "@/services/settings.service";
import { useTheme } from "@/providers/ThemeProvider";
import { SwatchPicker } from "@/components/common/accent-color-picker/AccentColorPicker";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Check, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnterKeyBehavior, NewProjectColor, TerminalColorMode } from "@/types/bindings";

const UI_SCALE_PRESETS = [
  { value: "100", label: "Default", hint: "100%", fontSize: 13 },
  { value: "115", label: "Comfortable", hint: "115%", fontSize: 15 },
  { value: "130", label: "Large", hint: "130%", fontSize: 17 },
] as const;

export function AppearanceSection() {
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });
  const {
    uiScale,
    setUiScale,
    isDark,
    projectAccentHue,
    setProjectAccentColor,
    globalAccentHue,
    setGlobalAccentColor,
    systemAccentHue,
  } = useTheme();
  const terminalColorMode = appSettings?.terminal_color_mode ?? "follow_theme";
  const enterKeyBehavior = appSettings?.enter_key_behavior ?? "send_prompt";
  const newProjectColor = appSettings?.new_project_color ?? "auto";
  const activeScale = uiScale ?? "100";

  function handleTerminalColorModeChange(value: string | null) {
    if (!appSettings || !value) return;
    saveAppSettings.mutate({
      ...appSettings,
      terminal_color_mode: value as TerminalColorMode,
      updated_at: new Date().toISOString(),
    });
  }

  function handleNewProjectColorChange(value: string | null) {
    if (!appSettings || !value) return;
    saveAppSettings.mutate({
      ...appSettings,
      new_project_color: value as NewProjectColor,
      updated_at: new Date().toISOString(),
    });
  }

  function handleEnterKeyBehaviorChange(value: string | null) {
    if (!appSettings || !value) return;
    saveAppSettings.mutate({
      ...appSettings,
      enter_key_behavior: value as EnterKeyBehavior,
      updated_at: new Date().toISOString(),
    });
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Monitor className="w-4 h-4 text-muted-foreground" />
        Appearance
      </h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Global Default Color</div>
            <div className="text-xs text-muted-foreground">
              Used by projects with no color of their own, and before a project is opened
            </div>
          </div>
          <SwatchPicker
            title="Global Default"
            selectedHue={globalAccentHue}
            fallbackHue={systemAccentHue ?? 250}
            fallbackLabel="Auto"
            fallbackDescription="Follows OS accent"
            isDark={isDark}
            onSelect={(hue) => void setGlobalAccentColor(hue)}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">This Project&apos;s Color</div>
            <div className="text-xs text-muted-foreground">
              Colors the header so you can tell projects apart at a glance
            </div>
          </div>
          <SwatchPicker
            title="Project Color"
            selectedHue={projectAccentHue}
            fallbackHue={globalAccentHue ?? systemAccentHue ?? 250}
            fallbackLabel="Global default"
            fallbackDescription="Follows the setting above"
            isDark={isDark}
            onSelect={(hue) => void setProjectAccentColor(hue)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">New Projects</Label>
        <Select value={newProjectColor} onValueChange={handleNewProjectColorChange}>
          <SelectTrigger className="w-full bg-muted">
            <SelectValue>
              {newProjectColor === "auto"
                ? "Assign a color automatically"
                : "Use the global default"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Assign a color automatically</SelectItem>
            <SelectItem value="global">Use the global default</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Whether a project opened for the first time gets a random color from the palette or stays
          on the global default
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">UI Scale</Label>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {UI_SCALE_PRESETS.map((preset) => {
            const isActive = activeScale === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => void setUiScale(preset.value)}
                className={cn(
                  "relative flex flex-col items-center gap-1.5 rounded-md border p-3 text-center transition-colors cursor-pointer",
                  isActive
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-border bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                )}
              >
                {isActive && (
                  <div className="absolute top-1.5 right-1.5 rounded-full bg-accent p-0.5">
                    <Check className="w-2.5 h-2.5 text-accent-foreground" />
                  </div>
                )}
                <span
                  style={{ fontSize: preset.fontSize }}
                  className="font-semibold leading-none select-none"
                >
                  Aa
                </span>
                <span className="text-xs font-medium leading-none">{preset.label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Scales all text, spacing, and UI elements uniformly.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Terminal Colors</Label>
        <Select value={terminalColorMode} onValueChange={handleTerminalColorModeChange}>
          <SelectTrigger className="w-full bg-muted">
            <SelectValue>
              {terminalColorMode === "follow_theme"
                ? "Follow app theme"
                : "Default (black background)"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="follow_theme">Follow app theme</SelectItem>
            <SelectItem value="default">Default (black background)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Whether the terminal background matches your app theme or uses standard xterm colors
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Enter Key Behavior</Label>
        <Select value={enterKeyBehavior} onValueChange={handleEnterKeyBehaviorChange}>
          <SelectTrigger className="w-full bg-muted">
            <SelectValue>
              {enterKeyBehavior === "send_prompt"
                ? "Send prompt (Shift+Enter for new line)"
                : "New line (Ctrl+Enter to send)"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="send_prompt">Send prompt (Shift+Enter for new line)</SelectItem>
            <SelectItem value="new_line">New line (Ctrl+Enter to send)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Controls what happens when you press Enter in the compose bar
        </p>
      </div>
    </div>
  );
}
