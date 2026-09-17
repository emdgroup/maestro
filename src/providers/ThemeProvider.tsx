import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import type { AppSettings } from "@/types/bindings";
import { oklch } from "culori";
import { api } from "@/lib/tauri-utils";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import { useProjectSettings, useSetProjectAccentColor } from "@/services/project.service";
import { useSelectedProject } from "@/store/projectStore";
import { randomPresetHue } from "@/utils/constants/accentColors";
import { reduceMotionDefault } from "@/lib/rendering";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { MotionConfig } from "framer-motion";

export type ThemeValue = "light" | "dark" | "system";

export interface ThemeContextValue {
  theme: ThemeValue;
  setTheme: (theme: ThemeValue) => Promise<void>;
  systemTheme: "light" | "dark";
  /** Whether dark is actually in effect — `theme` resolved against `systemTheme`. */
  isDark: boolean;
  isReady: boolean;
  /** The hue actually painted right now: project colour → global default → OS accent. */
  effectiveAccentHue: number | null;
  /** The selected project's own colour, or null when it follows the global default. */
  projectAccentHue: number | null;
  setProjectAccentColor: (hue: number | null) => Promise<void>;
  /** The global default colour, or null when it follows the OS accent. */
  globalAccentHue: number | null;
  setGlobalAccentColor: (hue: number | null) => Promise<void>;
  systemAccentHue: number | null;
  uiScale: string | null;
  setUiScale: (scale: string) => Promise<void>;
  /** Whether decorative animation is off — the stored choice, or the machine's default. */
  reduceMotion: boolean;
  setReduceMotion: (on: boolean) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ThemeValue, systemTheme: "light" | "dark"): void {
  const isDark = theme === "dark" || (theme === "system" && systemTheme === "dark");
  if (isDark) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

/**
 * One class on the root gates every decorative animation from `index.css`, so the components
 * carrying those class names need no knowledge of the setting.
 */
function applyReduceMotion(on: boolean): void {
  document.documentElement.classList.toggle("reduce-motion", on);
}

function applyUiScale(scale: string | null | undefined): void {
  const factor = scale ? parseInt(scale, 10) / 100 : 1;
  getCurrentWebview()
    .setZoom(factor)
    .catch(() => {});
}

/**
 * Categorical chart series, fanned out around the accent hue.
 *
 * The offsets are deliberately uneven and wide enough to stay apart once a colourblind viewer
 * collapses part of the wheel; the lightness step gives a second channel, so two adjacent series
 * differ in more than hue alone. Index 0 is the accent itself, so a single-series chart matches
 * the rest of the UI.
 */
const CHART_SERIES: Array<{ hue: number; lightness: number; chroma: number }> = [
  { hue: 0, lightness: 0, chroma: 0.15 },
  { hue: 150, lightness: 0.06, chroma: 0.14 },
  { hue: -60, lightness: -0.05, chroma: 0.16 },
  { hue: 70, lightness: 0.1, chroma: 0.13 },
  { hue: -130, lightness: -0.1, chroma: 0.15 },
];

function applyAccentHue(hue: number): void {
  const isDark = document.documentElement.classList.contains("dark");
  const lightness = isDark ? 0.75 : 0.5;
  const chroma = 0.15;
  document.documentElement.style.setProperty(
    "--accent",
    `oklch(${lightness * 100}% ${chroma} ${hue})`,
  );
  document.documentElement.style.setProperty(
    "--accent-foreground",
    isDark ? "oklch(25% 0.01 250)" : "oklch(100% 0 0)",
  );
  // Published so anything deriving its own shades — a canvas surface, say — can reach the hue
  // rather than re-deriving it from the resolved `--accent` colour.
  document.documentElement.style.setProperty("--accent-hue", String(hue));

  // Charts follow the accent. The static values in `index.css` are the pre-paint fallback and are
  // built the same way around the default hue, so nothing is grey at any point.
  CHART_SERIES.forEach((series, index) => {
    const l = Math.min(0.92, Math.max(0.35, lightness + series.lightness));
    document.documentElement.style.setProperty(
      `--chart-${index + 1}`,
      `oklch(${(l * 100).toFixed(1)}% ${series.chroma} ${(hue + series.hue + 360) % 360})`,
    );
  });
}

async function loadSystemAccentHue(): Promise<number> {
  const rgb = await api.getSystemAccentColor();
  const rgbColor = { mode: "rgb" as const, r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
  const oklchColor = oklch(rgbColor);
  return oklchColor?.h ?? 250;
}

function parseHue(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const hue = Number(value);
  return Number.isFinite(hue) ? hue : null;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeValue>("system");
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => getSystemTheme());
  const [isReady, setIsReady] = useState(false);
  const [globalAccentHue, setGlobalAccentHueState] = useState<number | null>(null);
  const [uiScale, setUiScaleState] = useState<string | null>(null);
  // Seeded from the machine so a software-rendering board is already quiet on the first render,
  // before the settings query resolves and can confirm or override it.
  const [reduceMotion, setReduceMotionState] = useState<boolean>(() => reduceMotionDefault());
  const [systemAccentHue, setSystemAccentHue] = useState<number | null>(null);
  const settingsQuery = useSettings();
  const saveSettings = useSaveSettings({ successToast: false });
  const systemAccentHueCacheRef = useRef<number | null>(null);

  const selectedProject = useSelectedProject();
  const projectSettingsQuery = useProjectSettings(selectedProject?.id ?? null);
  const projectAccentHue = parseHue(projectSettingsQuery.data?.accent_color);
  const setProjectAccentMutation = useSetProjectAccentColor();
  // Guards the once-per-project random assignment against re-renders and failed writes.
  const autoAssignedRef = useRef<Set<number>>(new Set());

  async function getSystemAccentHue(): Promise<number> {
    if (systemAccentHueCacheRef.current != null) return systemAccentHueCacheRef.current;
    const hue = await loadSystemAccentHue().catch(() => 250);
    systemAccentHueCacheRef.current = hue;
    setSystemAccentHue(hue);
    return hue;
  }

  // Loaded whether or not it is the hue being painted: the pickers preview what "follows the OS
  // accent" would look like even while an explicit colour is in effect.
  useEffect(() => {
    void getSystemAccentHue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (settingsQuery.data == null || isReady) return;
    const savedTheme = (settingsQuery.data.theme_preference as ThemeValue) || "system";
    setThemeState(savedTheme);
    applyTheme(savedTheme, systemTheme);

    setGlobalAccentHueState(parseHue(settingsQuery.data.accent_color));

    const savedScale = settingsQuery.data.ui_scale ?? null;
    setUiScaleState(savedScale);
    applyUiScale(savedScale);

    // `??`, not `||`: a stored `false` is a deliberate "keep the animation" on a machine the
    // detection would otherwise switch off, and has to win over it.
    const savedReduceMotion = settingsQuery.data.reduce_motion ?? reduceMotionDefault();
    setReduceMotionState(savedReduceMotion);
    applyReduceMotion(savedReduceMotion);

    setIsReady(true);
  }, [settingsQuery.data, isReady, systemTheme]);

  // The single place the accent is painted. Reacts to project switches, colour changes and
  // dark/light flips (the theme deps matter: applyAccentHue reads the dark class at call time,
  // so this must re-run after applyTheme has toggled it).
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    const explicit = projectAccentHue ?? globalAccentHue;
    if (explicit != null) {
      applyAccentHue(explicit);
      return;
    }
    void getSystemAccentHue().then((hue) => {
      if (!cancelled) applyAccentHue(hue);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, projectAccentHue, globalAccentHue, theme, systemTheme]);

  // A project opened with no colour of its own gets a random preset, persisted through the same
  // command an explicit pick uses — but only once the settings queries have actually resolved:
  // a "still loading" null must never be mistaken for "has no colour". `accent_color_auto_assign`
  // is what separates "never chosen" from a deliberate "follow the global default", which also
  // stores no hue.
  useEffect(() => {
    const project = selectedProject;
    if (!project || !projectSettingsQuery.isSuccess || settingsQuery.data == null) return;
    if (projectSettingsQuery.data.accent_color != null) return;
    if (projectSettingsQuery.data.accent_color_auto_assign === false) return;
    if ((settingsQuery.data.new_project_color ?? "auto") !== "auto") return;
    if (autoAssignedRef.current.has(project.id)) return;
    autoAssignedRef.current.add(project.id);
    void handleSetProjectAccentColor(randomPresetHue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedProject?.id,
    projectSettingsQuery.isSuccess,
    projectSettingsQuery.data?.accent_color,
    projectSettingsQuery.data?.accent_color_auto_assign,
    settingsQuery.data,
  ]);

  async function handleSetTheme(newTheme: ThemeValue): Promise<void> {
    const currentSettings = settingsQuery.data;
    if (!currentSettings) return;

    setThemeState(newTheme);
    applyTheme(newTheme, systemTheme);

    const updatedSettings: AppSettings = {
      ...currentSettings,
      theme_preference: newTheme,
      updated_at: new Date().toISOString(),
    };
    try {
      await saveSettings.mutateAsync(updatedSettings);
    } catch {
      setThemeState(theme);
      applyTheme(theme, systemTheme);
    }
  }

  async function handleSetGlobalAccentColor(hue: number | null): Promise<void> {
    const currentSettings = settingsQuery.data;
    if (!currentSettings) return;

    setGlobalAccentHueState(hue);

    const updatedSettings: AppSettings = {
      ...currentSettings,
      accent_color: hue != null ? String(hue) : null,
      updated_at: new Date().toISOString(),
    };
    await saveSettings.mutateAsync(updatedSettings);
  }

  /** Paints what a given project hue resolves to: its own colour → global default → OS accent. */
  async function paintProjectHue(hue: number | null): Promise<void> {
    const explicit = hue ?? globalAccentHue;
    applyAccentHue(explicit ?? (await getSystemAccentHue()));
  }

  async function handleSetProjectAccentColor(hue: number | null): Promise<void> {
    const project = selectedProject;
    if (!project) return;

    const previous = projectAccentHue;
    await paintProjectHue(hue);

    try {
      await setProjectAccentMutation.mutateAsync({
        projectId: project.id,
        accentColor: hue != null ? String(hue) : null,
      });
    } catch {
      // Error surfaced by the mutation's toast. Repainting has to be explicit: the optimistic
      // paint wrote to the DOM directly, so the refetch returning unchanged data re-renders
      // nothing and would leave a colour on screen that was never stored.
      await paintProjectHue(previous);
    }
  }

  async function handleSetUiScale(scale: string): Promise<void> {
    const currentSettings = settingsQuery.data;
    if (!currentSettings) return;

    setUiScaleState(scale);
    applyUiScale(scale);

    const updatedSettings: AppSettings = {
      ...currentSettings,
      ui_scale: scale,
      updated_at: new Date().toISOString(),
    };
    await saveSettings.mutateAsync(updatedSettings);
  }

  /** Always stores an explicit boolean: choosing either way ends the follow-the-machine default. */
  async function handleSetReduceMotion(on: boolean): Promise<void> {
    const currentSettings = settingsQuery.data;
    if (!currentSettings) return;

    setReduceMotionState(on);
    applyReduceMotion(on);

    const updatedSettings: AppSettings = {
      ...currentSettings,
      reduce_motion: on,
      updated_at: new Date().toISOString(),
    };
    try {
      await saveSettings.mutateAsync(updatedSettings);
    } catch {
      // The class was written to the DOM directly, so a failed save has to be undone here — a
      // refetch returning the old value re-renders nothing and would leave the class on.
      setReduceMotionState(!on);
      applyReduceMotion(!on);
    }
  }

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      const newSystemTheme = e.matches ? "dark" : "light";
      setSystemTheme(newSystemTheme);
      if (theme === "system") {
        applyTheme("system", newSystemTheme);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const value: ThemeContextValue = {
    theme,
    setTheme: handleSetTheme,
    systemTheme,
    isDark: theme === "dark" || (theme === "system" && systemTheme === "dark"),
    isReady,
    effectiveAccentHue: projectAccentHue ?? globalAccentHue ?? systemAccentHue,
    projectAccentHue,
    setProjectAccentColor: handleSetProjectAccentColor,
    globalAccentHue,
    setGlobalAccentColor: handleSetGlobalAccentColor,
    systemAccentHue,
    uiScale,
    setUiScale: handleSetUiScale,
    reduceMotion,
    setReduceMotion: handleSetReduceMotion,
  };

  // The CSS class covers everything animated by a stylesheet; MotionConfig covers the framer-motion
  // page transitions, which are driven from JS and never touch it. Mounted here because every
  // animation site — App's view slides, ProjectPicker's tab slides, AppHeader — sits below this
  // provider in main.tsx. It disables transform and layout animations; opacity still animates, so
  // a view swap cross-fades rather than sliding.
  return (
    <ThemeContext.Provider value={value}>
      <MotionConfig reducedMotion={reduceMotion ? "always" : "never"}>{children}</MotionConfig>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
