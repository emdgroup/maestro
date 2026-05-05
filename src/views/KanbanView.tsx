import { useState } from "react";
import { LayoutList, Kanban, Archive, SearchIcon } from "lucide-react";
import { BacklogView } from "@/components/views/BacklogView";
import { BoardView } from "@/components/views/BoardView";
import { ArchiveView } from "@/components/views/ArchiveView";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/ui/tooltip";
import { Input } from "@/ui/input";
import type { TaskPriority } from "@/types/bindings";
import { useActiveSubView, useNavigationActions } from "@/store/navigationStore";
import type { SubView } from "@/store/navigationStore";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";

type ArchiveFilter = "all" | "Done" | "Cancelled";
type BacklogPriorityFilter = "All" | TaskPriority;

const SUB_VIEWS: Array<{ id: SubView; label: string; icon: React.ElementType }> = [
  { id: "backlog", label: "Backlog", icon: LayoutList },
  { id: "board", label: "Board", icon: Kanban },
  { id: "archive", label: "Archive", icon: Archive },
];

const BACKLOG_PRIORITY_FILTERS: BacklogPriorityFilter[] = [
  "All",
  "Urgent",
  "High",
  "Medium",
  "Low",
];

/**
 * KanbanView - Page-level orchestrator for the Kanban board screen.
 * Renders an action bar and the active sub-view (Backlog / Board / Archive).
 */
export const KanbanView: React.FC = () => {
  const activeSubView = useActiveSubView();
  const { setActiveSubView } = useNavigationActions();
  const [archiveSearch, setArchiveSearch] = useState("");
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("all");
  const [backlogSearch, setBacklogSearch] = useState("");
  const [backlogPriorityFilter, setBacklogPriorityFilter] = useState<BacklogPriorityFilter>("All");

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
        {/* Left slot */}
        <div className="flex items-center gap-2">
          {activeSubView === "backlog" && (
            <>
              <InputGroup>
                <InputGroupInput
                  type="text"
                  placeholder="Search tasks..."
                  value={backlogSearch}
                  onChange={(e) => setBacklogSearch(e.target.value)}
                  className="h-8 w-48 text-sm"
                />
                <InputGroupAddon align="inline-start">
                  <SearchIcon className="text-muted-foreground" />
                </InputGroupAddon>
              </InputGroup>
              <ToggleGroup variant="outline" size="sm" defaultValue={["All"]}>
                {BACKLOG_PRIORITY_FILTERS.map((f) => (
                  <ToggleGroupItem
                    key={f}
                    value={f}
                    pressed={backlogPriorityFilter === f}
                    onClick={() => setBacklogPriorityFilter(f)}
                    className="text-xs px-3"
                  >
                    {f}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </>
          )}
          {activeSubView === "archive" && (
            <>
              <Input
                type="text"
                placeholder="Search tasks..."
                value={archiveSearch}
                onChange={(e) => setArchiveSearch(e.target.value)}
                className="h-8 w-48 text-sm"
              />
              <ToggleGroup variant="outline" size="sm" defaultValue={["All"]}>
                {(["All", "Done", "Cancelled"] as ArchiveFilter[]).map((f) => (
                  <ToggleGroupItem
                    key={f}
                    value={f}
                    pressed={archiveFilter === f}
                    onClick={() => setArchiveFilter(f)}
                    className="text-xs px-3"
                  >
                    {f}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </>
          )}
        </div>

        {/* Right slot — sub-view switcher */}
        <TooltipProvider delay={300}>
          <ToggleGroup variant="outline" size="sm" value={[activeSubView]}>
            {SUB_VIEWS.map((view) => (
              <Tooltip key={view.id}>
                <TooltipTrigger
                  render={
                    <ToggleGroupItem
                      value={view.id}
                      pressed={activeSubView === view.id}
                      onClick={() => setActiveSubView(view.id)}
                      aria-label={view.label}
                    >
                      <view.icon className="size-4" />
                    </ToggleGroupItem>
                  }
                />
                <TooltipContent side="bottom" sideOffset={8}>
                  {view.label}
                </TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
        </TooltipProvider>
      </div>

      {/* Active sub-view */}
      <div className="flex-1 min-h-0">
        {activeSubView === "backlog" && (
          <BacklogView search={backlogSearch} priorityFilter={backlogPriorityFilter} />
        )}
        {activeSubView === "board" && <BoardView />}
        {activeSubView === "archive" && (
          <ArchiveView search={archiveSearch} filter={archiveFilter} />
        )}
      </div>
    </div>
  );
};
