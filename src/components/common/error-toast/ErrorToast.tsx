import type { CSSProperties } from "react";
import { Toaster } from "sonner";
import { useTheme } from "@/providers/ThemeProvider";

/** Sonner reads its colours from these, on the tooltip's glass since a toast can land on anything. */
const GLASS = {
  "--normal-bg": "color-mix(in oklab, var(--card) 92%, transparent)",
  "--normal-border": "color-mix(in oklab, var(--foreground) 9%, transparent)",
  "--normal-text": "var(--foreground)",
  "--border-radius": "1rem",
} as CSSProperties;

export function ToasterRoot() {
  const { isDark } = useTheme();
  return (
    <Toaster
      theme={isDark ? "dark" : "light"}
      style={GLASS}
      position="bottom-right"
      visibleToasts={3}
      duration={4000}
      toastOptions={{
        classNames: {
          toast: "backdrop-blur-[20px] backdrop-saturate-150 shadow-pop!",
          success: "[&_[data-icon]]:text-success",
          error: "[&_[data-icon]]:text-destructive",
          info: "[&_[data-icon]]:text-info",
        },
      }}
    />
  );
}
