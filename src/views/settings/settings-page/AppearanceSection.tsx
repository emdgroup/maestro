import { useSettings, useSaveSettings } from "@/services/settings.service";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Monitor } from "lucide-react";
import type { EnterKeyBehavior, TerminalColorMode } from "@/types/bindings";

export function AppearanceSection() {
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });
  const terminalColorMode = appSettings?.terminal_color_mode ?? "follow_theme";
  const enterKeyBehavior = appSettings?.enter_key_behavior ?? "send_prompt";

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
            <SelectItem value="send_prompt">
              Send prompt (Shift+Enter for new line)
            </SelectItem>
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
