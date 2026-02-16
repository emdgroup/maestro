import { Sun, Moon, SunMoon } from "lucide-react";
import { useTheme, type ThemeValue } from "@/providers/ThemeProvider";
import type { ReactElement } from "react";
import { useState, useRef } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  TooltipArrow,
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
  const [open, setOpen] = useState(false);
  const isHovering = useRef(false);

  const handleMouseEnter = () => {
    isHovering.current = true;
    setOpen(true);
  };

  const handleMouseLeave = () => {
    isHovering.current = false;
    setOpen(false);
  };

  const handleClick = () => {
    setTheme(nextTheme);
    // Keep tooltip open if still hovering
    if (isHovering.current) {
      setOpen(true);
    }
  };

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            onClick={handleClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className="flex items-center justify-center h-7 w-7 rounded-full bg-muted hover:bg-muted/80 transition-colors [&>svg]:h-5 [&>svg]:w-5 [&>svg]:text-muted-foreground"
            aria-label={`Current theme: ${theme}. Click to cycle`}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={8}
          alignOffset={0}
          collisionPadding={8}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="bg-popover text-popover-foreground border border-border"
        >
          <TooltipArrow className="fill-popover" />
          <p className="text-xs">{title}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
