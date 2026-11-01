import { Sun, Moon, SunMoon } from "lucide-react";
import { useTheme, type ThemeValue } from "@/providers/ThemeProvider";
import type { MouseEvent, ReactElement } from "react";
import { useState, useRef } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { buttonVariants } from "@/ui/button";
import { cn } from "@/lib/utils";
import { morph } from "@/components/layout/project-transition/projectTransition";

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

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    const { left, top, width, height } = e.currentTarget.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const root = document.documentElement;
    root.classList.add("theme-reveal");
    const transition = morph(() => void setTheme(nextTheme));
    void transition?.ready.then(() => {
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.animate(
        { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 500,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    });
    void (transition?.finished ?? Promise.resolve()).finally(() =>
      root.classList.remove("theme-reveal"),
    );
    // Keep tooltip open if still hovering
    if (isHovering.current) {
      setOpen(true);
    }
  };

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <button
            onClick={handleClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "h-7 w-7 rounded-full [&>svg]:h-5 [&>svg]:w-5 [&>svg]:text-muted-foreground",
            )}
            aria-label={`Current theme: ${theme}. Click to cycle`}
          >
            {icon}
          </button>
        }
      />
      <TooltipContent side="bottom" sideOffset={8} alignOffset={0}>
        <p className="text-xs">{title}</p>
      </TooltipContent>
    </Tooltip>
  );
}
