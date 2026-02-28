import React, { createContext, useContext, useState, useEffect } from "react";
import type { AppSettings } from "@/types/bindings";
import { oklch } from "culori";
import { api } from "@/lib";

// Theme type definition
export type ThemeValue = "light" | "dark" | "system";

// Context value interface
export interface ThemeContextValue {
  theme: ThemeValue;
  setTheme: (theme: ThemeValue) => Promise<void>;
  systemTheme: "light" | "dark";
  isReady: boolean;
}

// Create the context
const ThemeContext = createContext<ThemeContextValue | null>(null);

// Helper function to detect system theme preference
function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Helper function to apply theme to DOM
function applyTheme(theme: ThemeValue, systemTheme: "light" | "dark"): void {
  const isDark = theme === "dark" || (theme === "system" && systemTheme === "dark");
  const htmlElement = document.documentElement;

  if (isDark) {
    htmlElement.classList.add("dark");
  } else {
    htmlElement.classList.remove("dark");
  }
}

// Helper function to load and inject system accent color
async function loadSystemAccentColor(): Promise<void> {
  try {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    // Get system accent color from settings service
    const rgb = await api.getSystemAccentColor();
    console.log("[Theme] System accent color (RGB):", rgb);

    // Convert RGB to oklch to extract hue
    const rgbColor = { mode: "rgb" as const, r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
    const oklchColor = oklch(rgbColor);

    if (!oklchColor) {
      throw new Error("Failed to convert RGB to oklch");
    }

    // Extract hue from system color (0-360)
    const hue = oklchColor.h || 250; // Fallback to blue if hue is undefined

    // Adjust lightness and chroma based on light/dark mode for proper contrast
    // Light mode: darker accent (50% lightness)
    // Dark mode: lighter accent (75% lightness)
    const lightness = isDark ? 0.75 : 0.5;
    const chroma = 0.15; // Keep saturation consistent

    const accentColor = `oklch(${lightness * 100}% ${chroma} ${hue})`;
    const accentForeground = isDark ? "oklch(25% 0.01 250)" : "oklch(100% 0 0)";

    document.documentElement.style.setProperty("--accent", accentColor);
    document.documentElement.style.setProperty("--accent-foreground", accentForeground);

    console.log(
      "[Theme] Accent color set to:",
      accentColor,
      "| hue:",
      hue,
      "| foreground:",
      accentForeground,
    );
  } catch (err) {
    console.error("[Theme] Failed to load system accent color, using fallback:", err);

    // Fallback to hardcoded blue if system color fetch fails
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const accentColor = isDark ? "oklch(75% 0.15 250)" : "oklch(50% 0.15 250)";
    const accentForeground = isDark ? "oklch(25% 0.01 250)" : "oklch(100% 0 0)";

    document.documentElement.style.setProperty("--accent", accentColor);
    document.documentElement.style.setProperty("--accent-foreground", accentForeground);
  }
}

// ThemeProvider component
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeValue>("system");
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">("light");
  const [isReady, setIsReady] = useState(false);

  // Initialize theme from database and system preference on mount
  useEffect(() => {
    async function initializeTheme() {
      try {
        // Detect system theme
        const system = getSystemTheme();
        setSystemTheme(system);

        // Load saved theme preference from database using settings service
        const settings = await api.getSettings();
        const savedTheme = (settings.theme_preference as ThemeValue) || "system";
        setThemeState(savedTheme);

        // Apply theme to DOM
        applyTheme(savedTheme, system);

        // Load and inject system accent color
        await loadSystemAccentColor();
      } catch (err) {
        console.error("Failed to load theme settings, using system theme:", err);
        // Fallback to system theme
        const system = getSystemTheme();
        setSystemTheme(system);
        setThemeState("system");
        applyTheme("system", system);
        // Still try to load accent color even on error
        await loadSystemAccentColor();
      } finally {
        setIsReady(true);
      }
    }

    void initializeTheme();
  }, []);

  // Handle theme changes and persist to database
  async function handleSetTheme(newTheme: ThemeValue): Promise<void> {
    try {
      // Update state
      setThemeState(newTheme);

      // Apply theme to DOM immediately
      applyTheme(newTheme, systemTheme);

      // Persist to database using settings service
      const settings = await api.getSettings();
      const updatedSettings: AppSettings = {
        ...settings,
        theme_preference: newTheme,
        updated_at: new Date().toISOString(),
      };
      await api.saveSettings(updatedSettings);
    } catch (err) {
      console.error("Failed to save theme preference:", err);
      // Revert state on error
      setThemeState(theme);
      applyTheme(theme, systemTheme);
    }
  }

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = async (e: MediaQueryListEvent) => {
      const newSystemTheme = e.matches ? "dark" : "light";
      setSystemTheme(newSystemTheme);

      // If user has system theme selected, reapply
      if (theme === "system") {
        applyTheme("system", newSystemTheme);
      }

      // Reload accent color when system theme changes
      await loadSystemAccentColor();
    };

    // Use addEventListener for better compatibility
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

// Hook to use theme context
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
