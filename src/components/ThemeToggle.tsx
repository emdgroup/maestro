import { Sun, Moon, SunMoon } from "lucide-react";
import { useTheme, type ThemeValue } from "@/providers/ThemeProvider";
import type { ReactElement } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ThemeConfig = {
  title: string;
  icon: ReactElement;
  nextTheme: ThemeValue;
};

const themeMap: Record<ThemeValue, ThemeConfig> = {
  light: { title: "Light mode", icon: <Sun />, nextTheme: "dark" },
  dark: { title: "Dark mode", icon: <Moon />, nextTheme: "system" },
  system: { title: "System sync", icon: <SunMoon />, nextTheme: "light" },
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { title, icon, nextTheme } = themeMap[theme];

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => {
              setTheme(nextTheme);
            }}
            className="flex items-center justify-center h-7 w-7 rounded-full bg-muted hover:bg-muted/80 transition-colors [&>svg]:h-5 [&>svg]:w-5 [&>svg]:text-muted-foreground"
            aria-label={`Current theme: ${theme}. Click to cycle`}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="bg-popover text-popover-foreground border border-border"
        >
          <p className="text-xs">{title}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
