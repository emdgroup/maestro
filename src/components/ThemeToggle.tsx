import { Sun, Moon, SunMoon } from "lucide-react";
import { useTheme } from "@/providers/ThemeProvider";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button
      onClick={() => {
        const nextTheme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
        setTheme(nextTheme);
      }}
      className="flex items-center justify-center h-8 w-8 rounded-full bg-muted hover:bg-muted/80 transition-colors"
      title={theme === "light" ? "Light mode" : theme === "dark" ? "Dark mode" : "System mode"}
      aria-label={`Current theme: ${theme}. Click to cycle`}
    >
      {theme === "light" ? (
        <Sun className="h-4 w-4 text-foreground" />
      ) : theme === "dark" ? (
        <Moon className="h-4 w-4 text-foreground" />
      ) : (
        <SunMoon className="h-4 w-4 text-foreground" />
      )}
    </button>
  );
}
