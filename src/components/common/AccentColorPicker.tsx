import { Palette, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { useTheme } from "@/providers/ThemeProvider";

const COLORS: Array<{ name: string; hue: number }> = [
  { name: "Blue", hue: 250 },
  { name: "Purple", hue: 300 },
  { name: "Pink", hue: 350 },
  { name: "Red", hue: 25 },
  { name: "Orange", hue: 55 },
  { name: "Yellow", hue: 85 },
  { name: "Green", hue: 145 },
  { name: "Teal", hue: 195 },
];

function swatchColor(hue: number, isDark: boolean): string {
  const lightness = isDark ? "75%" : "50%";
  return `oklch(${lightness} 0.15 ${hue})`;
}

export function AccentColorPicker() {
  const { accentHue, systemAccentHue, setAccentColor, systemTheme } = useTheme();
  const isDark = systemTheme === "dark";

  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center justify-center h-7 w-7 rounded-full hover:bg-muted/80 transition-colors [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-muted-foreground cursor-pointer"
        aria-label="Accent color"
        title="Accent color"
      >
        <Palette />
      </PopoverTrigger>

      <PopoverContent align="end" className="w-48 gap-3 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Accent Color
        </p>

        {/* Auto option */}
        <button
          onClick={() => void setAccentColor(null)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer border-0 ${
            accentHue === null
              ? "bg-accent/10 text-foreground"
              : "bg-transparent hover:bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          <span
            className="h-5 w-5 rounded-full shrink-0 flex items-center justify-center"
            style={{ background: swatchColor(systemAccentHue ?? 250, isDark) }}
          >
            {accentHue === null && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
          </span>
          <span className="flex flex-col">
            <span className="text-xs font-medium leading-tight">Auto</span>
            <span className="text-[10px] text-muted-foreground leading-tight">Follows OS</span>
          </span>
        </button>

        <div className="h-px bg-border" />

        {/* Color swatches */}
        <div className="grid grid-cols-4 gap-2">
          {COLORS.map(({ name, hue }) => (
            <button
              key={hue}
              title={name}
              onClick={() => void setAccentColor(hue)}
              className={`h-7 w-7 rounded-full flex items-center justify-center transition-transform cursor-pointer border-0 p-0 ${
                accentHue === hue
                  ? "scale-110 ring-2 ring-foreground ring-offset-1 ring-offset-background"
                  : "hover:scale-110"
              }`}
              style={{ background: swatchColor(hue, isDark) }}
            >
              {accentHue === hue && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
