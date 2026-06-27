import { useState, useCallback } from "react";
import { Bot, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/lib/ui-utils";
import { TRIGGER_CLASS } from "./BaseDropdownSelector";
import type { SelectorProps } from "./BaseDropdownSelector";
import type { ConfigOptionValue } from "../types";

function deriveGroup(value: string): string {
  if (value === "default") return "built-in";
  const colon = value.indexOf(":");
  if (colon > 0) return value.slice(0, colon);
  const dash = value.indexOf("-");
  if (dash > 0) return value.slice(0, dash);
  return value;
}

function groupOptions(options: ConfigOptionValue[]): [string, ConfigOptionValue[]][] {
  const groups = new Map<string, ConfigOptionValue[]>();
  for (const opt of options) {
    const group = deriveGroup(opt.value);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(opt);
  }
  for (const items of groups.values()) {
    items.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function AgentSelector({ option, value, onChange, disabled }: SelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const currentOption = option.options.find((o) => o.value === value);

  const filtered = search.trim()
    ? option.options.filter(
        (o) =>
          o.name.toLowerCase().includes(search.toLowerCase()) ||
          o.description?.toLowerCase().includes(search.toLowerCase()),
      )
    : option.options;

  const grouped = groupOptions(filtered);

  const handleSelect = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
      setSearch("");
    },
    [onChange],
  );

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  }, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger disabled={disabled} className={TRIGGER_CLASS}>
        <Bot className="size-3 shrink-0" />
        <span>{currentOption?.name ?? value}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-72 gap-0 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="custom-scrollbar max-h-[400px] overflow-y-auto">
          {grouped.length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">No agents match</p>
          )}
          {grouped.map(([group, items]) => (
            <div key={group}>
              <p className="sticky top-0 z-10 bg-popover px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {group}
              </p>
              {items.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={cn(
                    "w-full cursor-pointer border-l-2 border-transparent px-3 py-1.5 text-left",
                    "hover:bg-accent hover:text-accent-foreground",
                    opt.value === value && "border-l-primary bg-accent",
                  )}
                  onClick={() => handleSelect(opt.value)}
                >
                  <p className="truncate text-xs font-medium">{opt.name}</p>
                  {opt.description && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {opt.description}
                    </p>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
