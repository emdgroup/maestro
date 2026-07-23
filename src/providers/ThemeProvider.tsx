import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import type { AppSettings } from "@/types/bindings";
import { oklch } from "culori";
import { api } from "@/lib/tauri-utils";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type ThemeValue = "light" | "dark" | "system";

export interface ThemeContextValue {
  theme: ThemeValue;
  setTheme: (theme: ThemeValue) => Promise<void>;
  systemTheme: "light" | "dark";
  isReady: boolean;
  accentHue: number | null;
  systemAccentHue: number | null;
  setAccentColor: (hue: number | null) => Promise<void>;
  uiScale: string | null;
  setUiScale: (scale: string) => Promise<void>;
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

function applyUiScale(scale: string | null | undefined): void {
  const factor = scale ? parseInt(scale, 10) / 100 : 1;
  getCurrentWebview()
    .setZoom(factor)
    .catch(() => {});
}

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
}

async function loadSystemAccentHue(): Promise<number> {
  const rgb = await api.getSystemAccentColor();
  const rgbColor = { mode: "rgb" as const, r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
  const oklchColor = oklch(rgbColor);
  return oklchColor?.h ?? 250;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeValue>("system");
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => getSystemTheme());
  const [isReady, setIsReady] = useState(false);
  const [accentHue, setAccentHueState] = useState<number | null>(null);
  const [uiScale, setUiScaleState] = useState<string | null>(null);
  const [systemAccentHue, setSystemAccentHue] = useState<number | null>(null);
  const settingsQuery = useSettings();
  const saveSettings = useSaveSettings({ successToast: false });
  const systemAccentHueCacheRef = useRef<number | null>(null);

  async function getSystemAccentHue(): Promise<number> {
    if (systemAccentHueCacheRef.current != null) return systemAccentHueCacheRef.current;
    const hue = await loadSystemAccentHue().catch(() => 250);
    systemAccentHueCacheRef.current = hue;
    setSystemAccentHue(hue);
    return hue;
  }

  useEffect(() => {
    if (settingsQuery.data == null || isReady) return;
    const savedTheme = (settingsQuery.data.theme_preference as ThemeValue) || "system";
    setThemeState(savedTheme);
    applyTheme(savedTheme, systemTheme);

    const savedAccent = settingsQuery.data.accent_color;
    const customHue = savedAccent != null ? Number(savedAccent) : null;
    setAccentHueState(customHue);

    void getSystemAccentHue().then((hue) => {
      if (customHue == null) applyAccentHue(hue);
    });
    if (customHue != null) {
      applyAccentHue(customHue);
    }

    const savedScale = settingsQuery.data.ui_scale ?? null;
    setUiScaleState(savedScale);
    applyUiScale(savedScale);

    setIsReady(true);
  }, [settingsQuery.data, isReady, systemTheme]);

  async function handleSetTheme(newTheme: ThemeValue): Promise<void> {
    const currentSettings = settingsQuery.data;
    if (!currentSettings) return;

    setThemeState(newTheme);
    applyTheme(newTheme, systemTheme);
    // Re-apply accent with updated dark/light state
    const hue = accentHue ?? (await getSystemAccentHue());
    applyAccentHue(hue);

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

  async function handleSetAccentColor(hue: number | null): Promise<void> {
    const currentSettings = settingsQuery.data;
    if (!currentSettings) return;

    setAccentHueState(hue);

    if (hue != null) {
      applyAccentHue(hue);
    } else {
      const systemHue = await getSystemAccentHue();
      applyAccentHue(systemHue);
    }

    const updatedSettings: AppSettings = {
      ...currentSettings,
      accent_color: hue != null ? String(hue) : null,
      updated_at: new Date().toISOString(),
    };
    await saveSettings.mutateAsync(updatedSettings);
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

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = async (e: MediaQueryListEvent) => {
      const newSystemTheme = e.matches ? "dark" : "light";
      setSystemTheme(newSystemTheme);
      if (theme === "system") {
        applyTheme("system", newSystemTheme);
      }
      // Re-apply accent for new dark/light state
      const hue = accentHue ?? (await getSystemAccentHue());
      applyAccentHue(hue);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme, accentHue]);

  const value: ThemeContextValue = {
    theme,
    setTheme: handleSetTheme,
    systemTheme,
    isReady,
    accentHue,
    systemAccentHue,
    setAccentColor: handleSetAccentColor,
    uiScale,
    setUiScale: handleSetUiScale,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
