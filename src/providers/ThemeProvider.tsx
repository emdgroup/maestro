import React, { createContext, useContext, useState, useEffect } from "react";
import type { AppSettings } from "@/types/bindings";
import { oklch } from "culori";
import { api } from "@/lib/tauri-utils";
import { useSettings, useSaveSettings } from "@/services/settings.service";

export type ThemeValue = "light" | "dark" | "system";

export interface ThemeContextValue {
  theme: ThemeValue;
  setTheme: (theme: ThemeValue) => Promise<void>;
  systemTheme: "light" | "dark";
  isReady: boolean;
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

async function loadSystemAccentColor(): Promise<void> {
  try {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const rgb = await api.getSystemAccentColor();
    const rgbColor = { mode: "rgb" as const, r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
    const oklchColor = oklch(rgbColor);

    if (!oklchColor) {
      throw new Error("Failed to convert RGB to oklch");
    }

    const hue = oklchColor.h || 250;
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
  } catch (err) {
    console.error("Failed to load system accent color, using fallback:", err);
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.style.setProperty(
      "--accent",
      isDark ? "oklch(75% 0.15 250)" : "oklch(50% 0.15 250)",
    );
    document.documentElement.style.setProperty(
      "--accent-foreground",
      isDark ? "oklch(25% 0.01 250)" : "oklch(100% 0 0)",
    );
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeValue>("system");
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => getSystemTheme());
  const [isReady, setIsReady] = useState(false);
  const settingsQuery = useSettings();
  const saveSettings = useSaveSettings({successToast: false});

  useEffect(() => {
    if (settingsQuery.data == null || isReady) return;
    const savedTheme = (settingsQuery.data.theme_preference as ThemeValue) || "system";
    setThemeState(savedTheme);
    applyTheme(savedTheme, systemTheme);
    void loadSystemAccentColor();
    setIsReady(true);
  }, [settingsQuery.data, isReady, systemTheme]);

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

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = async (e: MediaQueryListEvent) => {
      const newSystemTheme = e.matches ? "dark" : "light";
      setSystemTheme(newSystemTheme);
      if (theme === "system") {
        applyTheme("system", newSystemTheme);
      }
      await loadSystemAccentColor();
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const value: ThemeContextValue = {
    theme,
    setTheme: handleSetTheme,
    systemTheme,
    isReady,
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
