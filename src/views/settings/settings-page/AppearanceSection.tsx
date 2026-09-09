import { useSettings, useSaveSettings } from "@/services/settings.service";
import { useTheme, type ThemeValue } from "@/providers/ThemeProvider";
import { SwatchPicker } from "@/components/common/accent-color-picker/AccentColorPicker";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { ArrowBigUp, CornerDownLeft, Keyboard, Monitor, Moon, Sun, SunMoon } from "lucide-react";
import { isMacOS } from "@/lib/platform";
import type { EnterKeyBehavior, NewProjectColor, TerminalColorMode } from "@/types/bindings";
import { OptionTile } from "./OptionTile";

const UI_SCALE_PRESETS = [
  { value: "100", label: "Default", hint: "100%", fontSize: 13 },
  { value: "115", label: "Comfortable", hint: "115%", fontSize: 15 },
  { value: "130", label: "Large", hint: "130%", fontSize: 17 },
] as const;

/// The same three values the header's ThemeToggle cycles through, laid out so the choice can
/// be made directly rather than by clicking until the right one comes round.
const THEME_PRESETS: { value: ThemeValue; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: SunMoon },
];

/// The compose bar sends on `ctrlKey || metaKey`, so the label has to name the key the user
/// actually has. There is no shared modifier-label helper to reach for.
const SEND_MODIFIER = isMacOS ? "⌘" : "Ctrl";

const ENTER_ICON = <CornerDownLeft />;

/// Both halves of the choice, spelled out as the key combinations they are rather than as a
/// sentence about them — the question this control answers is "what does Enter do", and a list
/// of bindings answers it without being read.
const ENTER_PRESETS: {
  value: EnterKeyBehavior;
  title: string;
  bindings: { keys: React.ReactNode; action: string }[];
}[] = [
  {
    value: "send_prompt",
    title: "Enter sends",
    bindings: [
      { keys: <Kbd>{ENTER_ICON}Enter</Kbd>, action: "Send prompt" },
      {
        keys: (
          <>
            <Kbd>
              <ArrowBigUp />
              Shift
            </Kbd>
            <span className="text-[10px]">+</span>
            <Kbd>{ENTER_ICON}Enter</Kbd>
          </>
        ),
        action: "New line",
      },
    ],
  },
  {
    value: "new_line",
    title: "Enter adds a new line",
    bindings: [
      {
        keys: (
          <>
            <Kbd>{SEND_MODIFIER}</Kbd>
            <span className="text-[10px]">+</span>
            <Kbd>{ENTER_ICON}Enter</Kbd>
          </>
        ),
        action: "Send prompt",
      },
      { keys: <Kbd>{ENTER_ICON}Enter</Kbd>, action: "New line" },
    ],
  },
];

export function AppearanceSection() {
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });
  const {
    uiScale,
    setUiScale,
    isDark,
    theme,
    setTheme,
    globalAccentHue,
    setGlobalAccentColor,
    systemAccentHue,
    reduceMotion,
    setReduceMotion,
  } = useTheme();
  const terminalColorMode = appSettings?.terminal_color_mode ?? "follow_theme";
  const enterKeyBehavior = appSettings?.enter_key_behavior ?? "send_prompt";
  const newProjectColor = appSettings?.new_project_color ?? "auto";
  const activeScale = uiScale ?? "100";

  function handleTerminalFollowsThemeChange(checked: boolean) {
    if (!appSettings) return;
    saveAppSettings.mutate({
      ...appSettings,
      terminal_color_mode: (checked ? "follow_theme" : "default") satisfies TerminalColorMode,
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

  function handleNativeWindowFrameChange(checked: boolean) {
    if (!appSettings) return;
    saveAppSettings.mutate({
      ...appSettings,
      native_window_frame: checked,
      updated_at: new Date().toISOString(),
    });
  }

  function handleEnterKeyBehaviorChange(value: EnterKeyBehavior) {
    if (!appSettings) return;
    saveAppSettings.mutate({
      ...appSettings,
      enter_key_behavior: value,
      updated_at: new Date().toISOString(),
    });
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Monitor className="w-4 h-4 text-muted-foreground" />
        Appearance
      </h3>

      {/* Absent on macOS: it uses its native title bar either way, so there is no off state to
          offer and a permanently dead switch would only mislead. */}
      {!isMacOS && (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">System title bar</div>
            <div className="text-xs text-muted-foreground">
              Use the OS window frame instead of Maestro&apos;s own. Restores Snap Layouts and the
              window shadow on Windows.
            </div>
          </div>
          <Switch
            tone="accent"
            checked={appSettings?.native_window_frame ?? false}
            onCheckedChange={handleNativeWindowFrameChange}
            className="data-unchecked:bg-muted data-unchecked:border-border/50"
          />
        </div>
      )}

      {/* As much a performance control as an accessibility one: the background animation costs one
          composited layer per bubble, which a machine rendering in software pays for on the CPU. */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Reduce motion</div>
          <div className="text-xs text-muted-foreground">
            Turn off background animation and view transitions. On by default when your system asks
            for reduced motion or has no graphics acceleration.
          </div>
        </div>
        <Switch
          tone="accent"
          checked={reduceMotion}
          onCheckedChange={(checked) => void setReduceMotion(checked)}
          className="data-unchecked:bg-muted data-unchecked:border-border/50"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Terminal follows app theme</div>
          <div className="text-xs text-muted-foreground">
            Match terminal backgrounds and colors to your theme. Off uses the standard xterm palette
            on black.
          </div>
        </div>
        {/* Named explicitly: the row's title is a sibling `div`, so nothing associates it with
            the control and a screen reader would announce an unlabelled switch. */}
        <Switch
          tone="accent"
          aria-label="Terminal follows app theme"
          checked={terminalColorMode === "follow_theme"}
          onCheckedChange={handleTerminalFollowsThemeChange}
          className="data-unchecked:bg-muted data-unchecked:border-border/50"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Theme</Label>
        <div className="grid grid-cols-3 gap-2">
          {THEME_PRESETS.map((preset) => {
            const Icon = preset.icon;
            return (
              <OptionTile
                key={preset.value}
                selected={theme === preset.value}
                onSelect={() => void setTheme(preset.value)}
                className="flex flex-col items-center gap-1.5 text-center"
              >
                <Icon className="size-4.5" />
                <span className="text-xs font-medium leading-none">{preset.label}</span>
              </OptionTile>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          System follows your OS setting and changes with it.
        </p>
      </div>

      {/* A project's own colour is not here: it is a project setting, and lives on the
          project's Appearance page. */}
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
          {UI_SCALE_PRESETS.map((preset) => (
            <OptionTile
              key={preset.value}
              selected={activeScale === preset.value}
              onSelect={() => void setUiScale(preset.value)}
              className="flex flex-col items-center gap-1.5 text-center"
            >
              <span
                style={{ fontSize: preset.fontSize }}
                className="font-semibold leading-none select-none"
              >
                Aa
              </span>
              <span className="text-xs font-medium leading-none">{preset.label}</span>
            </OptionTile>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Scales all text, spacing, and UI elements uniformly.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium flex items-center gap-2">
          <Keyboard className="w-4 h-4 text-muted-foreground" />
          Enter Key Behavior
        </Label>
        <div className="grid grid-cols-2 gap-2">
          {ENTER_PRESETS.map((preset) => (
            <OptionTile
              key={preset.value}
              selected={enterKeyBehavior === preset.value}
              onSelect={() => handleEnterKeyBehaviorChange(preset.value)}
              className="text-left"
            >
              <div className="text-xs font-semibold mb-2">{preset.title}</div>
              {preset.bindings.map((binding) => (
                <div key={binding.action} className="flex items-center gap-2 mt-1">
                  <KbdGroup>{binding.keys}</KbdGroup>
                  <span className="text-xs text-muted-foreground">{binding.action}</span>
                </div>
              ))}
            </OptionTile>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Applies when talking to an agent.</p>
      </div>
    </div>
  );
}
