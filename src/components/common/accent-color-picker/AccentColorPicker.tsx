import { Palette, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useTheme } from "@/providers/ThemeProvider";
import { ACCENT_COLORS, swatchColor } from "@/utils/constants/accentColors";

interface SwatchGridProps {
  /** The stored hue this grid edits (project or global), null when unset. */
  selectedHue: number | null;
  /** Hue previewed on the "unset" entry — what the colour falls back to. */
  fallbackHue: number;
  fallbackLabel: string;
  fallbackDescription: string;
  isDark: boolean;
  onSelect: (hue: number | null) => void;
}

/** The 16-preset picker body, shared between the header popover and the settings page. */
export function SwatchGrid({
  selectedHue,
  fallbackHue,
  fallbackLabel,
  fallbackDescription,
  isDark,
  onSelect,
}: SwatchGridProps) {
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer border-0 ${
          selectedHue === null
            ? "bg-accent/10 text-foreground"
            : "bg-transparent hover:bg-muted text-muted-foreground hover:text-foreground"
        }`}
      >
        <span
          className="h-7 w-7 rounded-full shrink-0 flex items-center justify-center"
          style={{ background: swatchColor(fallbackHue, isDark) }}
        >
          {selectedHue === null && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
        </span>
        <span className="flex flex-col">
          <span className="text-xs font-medium leading-tight">{fallbackLabel}</span>
          <span className="text-[10px] text-muted-foreground leading-tight">
            {fallbackDescription}
          </span>
        </span>
      </button>

      <div className="h-px bg-border" />

      <div className="grid grid-cols-4 gap-2">
        {ACCENT_COLORS.map(({ name, hue }) => (
          <Tooltip key={hue}>
            <TooltipTrigger
              onClick={() => onSelect(hue)}
              className={`h-7 w-7 rounded-full flex items-center justify-center transition-transform cursor-pointer border-0 p-0 ${
                selectedHue === hue
                  ? "scale-110 ring-2 ring-foreground ring-offset-1 ring-offset-background"
                  : "hover:scale-110"
              }`}
              style={{ background: swatchColor(hue, isDark) }}
            >
              {selectedHue === hue && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
            </TooltipTrigger>
            <TooltipContent>{name}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </>
  );
}

interface SwatchPickerProps extends SwatchGridProps {
  /** Heading inside the popover. */
  title: string;
}

/**
 * The current colour as a single swatch; the full palette lives behind a click. Sized to sit
 * in a settings row where a Switch would, so the section reads as one line per setting.
 */
export function SwatchPicker({ title, ...grid }: SwatchPickerProps) {
  const preset =
    grid.selectedHue === null ? null : ACCENT_COLORS.find(({ hue }) => hue === grid.selectedHue);
  // A stored hue outside the palette is possible: it is what the OS accent resolves to.
  const label = grid.selectedHue === null ? grid.fallbackLabel : (preset?.name ?? "Custom");
  const shownHue = grid.selectedHue ?? grid.fallbackHue;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              className="h-6 w-6 shrink-0 rounded-full border-0 p-0 ring-1 ring-border transition-transform hover:scale-110 cursor-pointer"
              style={{ background: swatchColor(shownHue, grid.isDark) }}
              aria-label={`${title}: ${label}`}
            />
          }
        />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-48 gap-3 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <SwatchGrid {...grid} />
      </PopoverContent>
    </Popover>
  );
}

/** Header popover editing the *current project's* colour, not the global default. */
export function AccentColorPicker() {
  const { projectAccentHue, globalAccentHue, systemAccentHue, setProjectAccentColor, isDark } =
    useTheme();

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              className="flex items-center justify-center h-7 w-7 rounded-full hover:bg-muted/80 transition-colors [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-muted-foreground cursor-pointer"
              aria-label="Project color"
            />
          }
        >
          <Palette />
        </TooltipTrigger>
        <TooltipContent>Project color</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-48 gap-3 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Project Color
        </p>
        <SwatchGrid
          selectedHue={projectAccentHue}
          fallbackHue={globalAccentHue ?? systemAccentHue ?? 250}
          fallbackLabel="Global default"
          fallbackDescription="Follows app setting"
          isDark={isDark}
          onSelect={(hue) => void setProjectAccentColor(hue)}
        />
      </PopoverContent>
    </Popover>
  );
}
