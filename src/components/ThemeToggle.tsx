import { Sun, Moon, SunMoon } from "lucide-react";
import { useTheme, type ThemeValue } from "@/providers/ThemeProvider";
import type { ReactElement } from "react";

type ThemeConfig = {
  title: string;
  icon: ReactElement;
  nextTheme: ThemeValue;
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const themeMap: Record<ThemeValue, ThemeConfig> = {
    light: { title: "Light mode", icon: <Sun />, nextTheme: "dark" },
    dark: { title: "Dark mode", icon: <Moon />, nextTheme: "system" },
    system: { title: "System sync", icon: <SunMoon />, nextTheme: "light" },
  };

  const { title, icon, nextTheme } = themeMap[theme];

  return (
    <button
      onClick={() => {
        setTheme(nextTheme);
      }}
      className="flex items-center justify-center h-7 w-7 rounded-full bg-muted hover:bg-muted/80 transition-colors [&>svg]:h-5 [&>svg]:w-5 [&>svg]:text-muted-foreground"
      title={title}
      aria-label={`Current theme: ${theme}. Click to cycle`}
    >
      {icon}
    </button>
  );
}
