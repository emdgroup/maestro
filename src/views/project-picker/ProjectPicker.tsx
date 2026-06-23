import { useState, useRef } from "react";
import { Cable, Server } from "lucide-react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { Button } from "@/ui/button";
import { cn } from "@/lib/ui-utils";
import { ConnectionList } from "./connection-list/ConnectionList";
import { ProjectList } from "./project-list/ProjectList";
import { IntegrationsTab } from "./integrations-tab/IntegrationsTab";
import { ThemeToggle } from "@/components/common/theme-toggle/ThemeToggle";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import {
  slideVariants,
  PAGE_TRANSITION_DURATION,
  PAGE_TRANSITION_EASING,
} from "@/utils/constants/animations";

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
      {/* Theme Toggle - Top Right */}
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="max-w-3xl w-full">
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
