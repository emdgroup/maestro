import { Palette } from "lucide-react";
import { useTheme } from "@/providers/ThemeProvider";
import { SwatchPicker } from "@/components/common/accent-color-picker/AccentColorPicker";

export function ProjectAppearanceSection() {
  const { isDark, projectAccentHue, setProjectAccentColor, globalAccentHue, systemAccentHue } =
    useTheme();

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Palette className="w-4 h-4 text-muted-foreground" />
        Appearance
      </h3>

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
          fallbackDescription="Follows the global default in Application → Appearance"
          isDark={isDark}
          onSelect={(hue) => void setProjectAccentColor(hue)}
        />
      </div>
    </div>
  );
}
