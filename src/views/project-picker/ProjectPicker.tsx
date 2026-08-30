import { useState, useRef, useEffect } from "react";
import { Cable, Server, CircleFadingArrowUp, LoaderCircle, Settings } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdater } from "@/hooks/useUpdater";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { UpdateCard } from "@/components/settings/UpdateCard";
import { SettingsPage } from "@/views/settings/settings-page/SettingsPage";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils.ts";
import { ConnectionList } from "./connection-list/ConnectionList";
import { ProjectList } from "./project-list/ProjectList";
import { IntegrationsTab } from "./integrations-tab/IntegrationsTab";
import { ThemeToggle } from "@/components/common/theme-toggle/ThemeToggle";
import { GlobalAccentColorPicker } from "@/components/common/accent-color-picker/AccentColorPicker";
import { AccentBubbles } from "@/components/common/accent-bubbles/AccentBubbles";
import { WindowControls } from "@/components/layout/window-chrome/WindowControls";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import {
  slideVariants,
  PAGE_TRANSITION_DURATION,
  PAGE_TRANSITION_EASING,
} from "@/utils/constants/animations";

function VersionBadge() {
  const [appVersion, setAppVersion] = useState("…");
  const { status } = useUpdater();
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const icon =
    status.phase === "available" ? (
      <span className="relative flex items-center justify-center">
        <span className="absolute -inset-1 rounded-full bg-accent/50 animate-ping" />
        <CircleFadingArrowUp className="w-3.5 h-3.5 relative text-accent" />
      </span>
    ) : status.phase === "downloading" ? (
      <LoaderCircle className="w-3.5 h-3.5 animate-spin text-accent" />
    ) : null;

  return (
    <Popover>
      <PopoverTrigger className="absolute bottom-4 right-4 flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer border border-transparent hover:border-border/50">
        {icon}v{appVersion}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-fit p-3">
        <UpdateCard />
      </PopoverContent>
    </Popover>
  );
}

type TabId = "connections" | "integrations";

const TABS: Array<{
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "connections", label: "Connections", icon: Server },
  { id: "integrations", label: "Integrations", icon: Cable },
];

const TAB_ORDER: TabId[] = ["connections", "integrations"];

export function ProjectPicker() {
  const { view } = useConnectionContext();
  const [activeTab, setActiveTab] = useState<TabId>("connections");
  const [tabSlideDir, setTabSlideDir] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prevTabRef = useRef<TabId>("connections");

  const handleTabClick = (tab: TabId) => {
    if (tab === prevTabRef.current) return;
    const prevIdx = TAB_ORDER.indexOf(prevTabRef.current);
    const newIdx = TAB_ORDER.indexOf(tab);
    setTabSlideDir(newIdx > prevIdx ? 1 : -1);
    prevTabRef.current = tab;
    setActiveTab(tab);
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground p-8 relative">
      {/* The screen paints its own background, so these cannot sit behind it on a negative
          layer the way they do in the header — they go at z-0 and the content is raised. */}
      <span aria-hidden className="screen-gradient z-0" />
      <AccentBubbles variant="screen" className="z-0" />

      {/* This screen has no AppHeader, so it carries its own drag region — without one a
          frameless window cannot be moved from the picker at all. */}
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-10 flex h-12 items-center justify-end gap-1 px-4"
      >
        <GlobalAccentColorPicker />
        <ThemeToggle />
        {/* App-wide settings without opening a project first — log level, notifications,
            concurrency and updates were otherwise unreachable from this screen. Styled off
            PalettePopover's trigger rather than a Button variant, so the three icons in this
            row share one hover treatment. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex items-center justify-center h-7 w-7 rounded-full hover:bg-muted/80 transition-colors [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-muted-foreground cursor-pointer"
                aria-label="Settings"
              />
            }
          >
            <Settings />
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
            <p className="text-xs">Settings</p>
          </TooltipContent>
        </Tooltip>
        <WindowControls className="-mr-2 ml-1" />
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        {/* The close button defaults to `top-4`, which centres a 32px control against a 64px
            header — this one sits in a 48px strip, so it needs `top-2` to line up with the
            controls beside it. */}
        <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl [&>[data-slot=dialog-close]]:top-2">
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <div className="min-h-0 flex-1">
            {/* No projectId or connection: only the Application group is registered.
                `headerPadEnd` keeps the header bar clear of the dialog's close button, and the
                dialog is already the card, so it supplies no second frame. */}
            <SettingsPage headerPadEnd framed={false} />
          </div>
        </DialogContent>
      </Dialog>

      <VersionBadge />

      <div className="max-w-3xl w-full relative z-10">
        <div className="text-center mb-8">
          <img src="/maestro-logo.png" alt="Maestro logo" className="w-20 h-20 mx-auto mb-4" />
          <h1 className="text-3xl font-semibold mb-3">Maestro</h1>
          <h3 className="text-base text-muted-foreground">An agent orchestrator tool.</h3>
        </div>

        {/* Single Panel with Slide Transition */}
        <div className="bg-card border border-border rounded-lg overflow-clip relative min-h-125 max-h-175">
          {/* Connections View */}
          <div
            data-testid="connections-panel"
            className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
              view === "projects" ? "-translate-x-full invisible" : "translate-x-0"
            }`}
          >
            {/* Tab bar matching AppHeader style */}
            <LayoutGroup id="picker-tab-nav">
              <div className="grid grid-cols-2 rounded-lg bg-muted p-1 gap-1 mb-4">
                {TABS.map((tab) => {
                  const isActive = activeTab === tab.id;
                  const Icon = tab.icon;
                  return (
                    <Button
                      key={tab.id}
                      variant="ghost"
                      onClick={() => handleTabClick(tab.id)}
                      className={cn(
                        "relative flex w-full items-center justify-center rounded-md px-3 py-1.5 h-auto text-xs font-medium",
                        isActive ? "hover:bg-transparent" : "hover:bg-background/50",
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="picker-active-pill"
                          className="absolute inset-0 rounded-md bg-background shadow-sm"
                          transition={{ type: "spring", stiffness: 400, damping: 35 }}
                        />
                      )}
                      <motion.span
                        animate={{ color: isActive ? "var(--accent)" : "var(--muted-foreground)" }}
                        transition={{ duration: 0.15 }}
                        className="relative z-10 flex items-center gap-1.5"
                      >
                        <Icon className="size-3.5" />
                        {tab.label}
                      </motion.span>
                    </Button>
                  );
                })}
              </div>
            </LayoutGroup>

            {/* Animated tab content */}
            <div className="flex-1 relative overflow-hidden">
              <AnimatePresence initial={false} custom={tabSlideDir}>
                <motion.div
                  key={activeTab}
                  custom={tabSlideDir}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
                  className="absolute inset-0 overflow-hidden"
                >
                  {activeTab === "connections" && <ConnectionList />}
                  {activeTab === "integrations" && <IntegrationsTab />}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Projects View */}
          <div
            data-testid="projects-panel"
            className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
              view === "projects" ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <ProjectList />
          </div>
        </div>
      </div>
    </div>
  );
}
