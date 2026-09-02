/**
 * The preset palette for project and global accent colours.
 *
 * Hues are OKLCH hue angles; lightness/chroma are fixed per theme (see swatchColor and
 * ThemeProvider.applyAccentHue), so a colour is stored as its hue alone — the same convention
 * as `AppSettings.accent_color` and `ProjectConfig.accent_color` on the Rust side.
 */
export interface AccentColor {
  name: string;
  hue: number;
}

/**
 * The hue used when nothing else answers — no project colour, no global default, and the OS
 * accent unreadable. Every fallback in the accent chain resolves here, so this constant alone
 * decides what "default colour" means.
 */
export const DEFAULT_ACCENT_HUE = 295;

export const ACCENT_COLORS: AccentColor[] = [
  { name: "Red", hue: 25 },
  { name: "Orange", hue: 50 },
  { name: "Amber", hue: 70 },
  { name: "Yellow", hue: 95 },
  { name: "Lime", hue: 120 },
  { name: "Green", hue: 145 },
  { name: "Emerald", hue: 165 },
  { name: "Teal", hue: 190 },
  { name: "Cyan", hue: 210 },
  { name: "Sky", hue: 230 },
  { name: "Blue", hue: 250 },
  { name: "Indigo", hue: 275 },
  { name: "Violet", hue: 295 },
  { name: "Purple", hue: 315 },
  { name: "Magenta", hue: 335 },
  { name: "Pink", hue: 355 },
];

export function swatchColor(hue: number, isDark: boolean): string {
  const lightness = isDark ? "75%" : "50%";
  return `oklch(${lightness} 0.15 ${hue})`;
}

/** One of the 16 preset hues at random — used by the "assign automatically" policy. */
export function randomPresetHue(): number {
  const index = Math.floor(Math.random() * ACCENT_COLORS.length);
  const color = ACCENT_COLORS[index];
  return color ? color.hue : DEFAULT_ACCENT_HUE;
}

/**
 * The precedence rule for the effective accent hue:
 * explicit project colour → global default → OS accent.
 */
export function resolveProjectHue(options: {
  projectAccent: number | null;
  globalAccent: number | null;
  systemAccent: number;
}): number {
  return options.projectAccent ?? options.globalAccent ?? options.systemAccent;
}
