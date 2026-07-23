import { useSettings, useSaveSettings } from "@/services/settings.service";
import { useTheme } from "@/providers/ThemeProvider";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Check, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnterKeyBehavior, TerminalColorMode } from "@/types/bindings";

const UI_SCALE_PRESETS = [
  { value: "100", label: "Default", hint: "100%", fontSize: 13 },
  { value: "115", label: "Comfortable", hint: "115%", fontSize: 15 },
  { value: "130", label: "Large", hint: "130%", fontSize: 17 },
] as const;

export function AppearanceSection() {
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });
  const { uiScale, setUiScale } = useTheme();
  const terminalColorMode = appSettings?.terminal_color_mode ?? "follow_theme";
  const enterKeyBehavior = appSettings?.enter_key_behavior ?? "send_prompt";
  const activeScale = uiScale ?? "100";
  const activePreset = UI_SCALE_PRESETS.find((p) => p.value === activeScale) ?? UI_SCALE_PRESETS[0];

  function handleTerminalColorModeChange(value: string | null) {
    if (!appSettings || !value) return;
    saveAppSettings.mutate({
      ...appSettings,
      terminal_color_mode: value as TerminalColorMode,
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

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">UI Scale</Label>
          <span className="text-xs text-muted-foreground">
            {activePreset.hint} — {activePreset.label}
          </span>
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
                <span className="text-[10px] leading-none opacity-60">{preset.hint}</span>
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
