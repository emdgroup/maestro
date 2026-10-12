import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export interface FilterOption {
  id: string;
  name: string;
  /** The project's connection, or the model's agents. */
  qualifier: string;
}

interface FilterMenuProps {
  projects: FilterOption[];
  models: FilterOption[];
  /** The ids of the options filtered on, projects and models alike. */
  selected: string[];
  onToggle: (kind: "project" | "model", id: string) => void;
}

/** `+ Filter`: a checklist of the range's projects and models, in the lists' order. */
export function FilterMenu({ projects, models, selected, onToggle }: FilterMenuProps) {
  const group = (kind: "project" | "model", title: string, options: FilterOption[]) =>
    options.length > 0 && (
      <div>
        <div className="px-1.5 pt-1 pb-1 text-[11px] text-muted-foreground">{title}</div>
        {options.map((option) => {
          const on = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              onClick={() => onToggle(kind, option.id)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-foreground/5"
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-[5px] border border-border",
                  on && "border-accent bg-accent text-accent-foreground",
                )}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="shrink-0 font-medium">{option.name}</span>
              <span className="truncate text-muted-foreground">{option.qualifier}</span>
            </button>
          );
        })}
      </div>
    );
  return (
    <Popover>
      <PopoverTrigger className="flex cursor-pointer items-center gap-1 rounded-full border border-foreground/15 py-0.5 pr-2.5 pl-2 text-[11px] text-foreground hover:bg-foreground/5">
        <Plus className="size-3" />
        Filter
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="home-pop max-h-80 w-96 gap-2 overflow-y-auto rounded-2xl p-2"
      >
        {group("project", "Projects", projects)}
        {group("model", "Models", models)}
        {!projects.length && !models.length && (
          <div className="p-1.5 text-xs text-muted-foreground">Nothing in this range.</div>
        )}
      </PopoverContent>
    </Popover>
  );
}
