import { useState } from "react";
import { motion, LayoutGroup } from "framer-motion";
import { BacklogView } from "@/components/views/BacklogView";
import { BoardView } from "@/components/views/BoardView";
import { ArchiveView } from "@/components/views/ArchiveView";

type SubView = "backlog" | "board" | "archive";

const SUB_VIEWS: Array<{ id: SubView; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "board", label: "Board" },
  { id: "archive", label: "Archive" },
];

/**
 * KanbanView - Page-level orchestrator for the Kanban board screen.
 * Renders a sub-view switcher (Backlog / Board / Archive) and the active sub-view.
 *
 * Context: Uses KanbanProvider for project data and callbacks (no prop drilling)
 */
export const KanbanView: React.FC = () => {
  const [activeSubView, setActiveSubView] = useState<SubView>("board");

  return (
    <div className="flex flex-col h-full">
      {/* Sub-view tab bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
        <LayoutGroup id="kanban-subview-tabs">
          <div className="relative flex items-center gap-1 rounded-lg bg-muted p-1">
            <motion.span
              className="absolute inset-y-1 left-1 rounded-md bg-background shadow-sm"
              style={{ width: "calc((100% - 0.5rem) / 3)" }}
              animate={{
                x: `calc(${SUB_VIEWS.findIndex((v) => v.id === activeSubView)} * 100%)`,
              }}
              transition={{ type: "spring", stiffness: 500, damping: 35 }}
            />
            {SUB_VIEWS.map((view) => {
              const isActive = activeSubView === view.id;
              return (
                <button
                  key={view.id}
                  onClick={() => setActiveSubView(view.id)}
                  className={`relative z-10 px-4 py-1.5 text-xs font-medium rounded-md transition-colors outline-none ${
                    isActive ? "" : "cursor-pointer hover:bg-background/50"
                  }`}
                >
                  <motion.span
                    animate={{
                      color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
                    }}
                    transition={{ duration: 0.15 }}
                  >
                    {view.label}
                  </motion.span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
      </div>

      {/* Active sub-view */}
      <div className="flex-1 min-h-0">
        {activeSubView === "backlog" && <BacklogView />}
        {activeSubView === "board" && <BoardView />}
        {activeSubView === "archive" && <ArchiveView />}
      </div>
    </div>
  );
};
