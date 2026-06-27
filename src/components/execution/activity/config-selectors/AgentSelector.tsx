import { useState, useCallback } from "react";
import { Bot, Check, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/lib/ui-utils";
import { TRIGGER_CLASS, GLASS_CONTENT_CLASS } from "./BaseDropdownSelector";
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
  const [hoveredOpt, setHoveredOpt] = useState<ConfigOptionValue | null>(null);

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
    if (!next) {
      setSearch("");
      setHoveredOpt(null);
    }
  }, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger disabled={disabled} className={TRIGGER_CLASS}>
        <Bot className="size-3 shrink-0" />
        <span>{currentOption?.name ?? value}</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className={cn(GLASS_CONTENT_CLASS, "relative w-72 gap-0 overflow-visible p-0")}
      >
        <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="custom-scrollbar max-h-[400px] overflow-y-auto overflow-x-visible p-1">
          {grouped.length === 0 && (
            <p className="py-4 text-left text-xs text-muted-foreground px-2">No agents match</p>
          )}
          {grouped.map(([group, items]) => (
            <div key={group}>
              <p className="sticky top-0 z-10 bg-muted/80 px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {group}
              </p>
              {items.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={cn(
                    "group relative flex w-full cursor-default items-start gap-2 rounded-sm py-2 pl-2 pr-2 text-left outline-none select-none",
                    "hover:bg-accent hover:text-accent-foreground",
                  )}
                  onMouseEnter={() => setHoveredOpt(opt)}
                  onMouseLeave={() => setHoveredOpt(null)}
                  onClick={() => handleSelect(opt.value)}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p
                      className={cn(
                        "truncate text-xs font-medium leading-none group-hover:!text-accent-foreground",
                        opt.value === value && "text-accent",
                      )}
                    >
                      {opt.name}
                    </p>
                    {opt.description && (
                      <p className="truncate text-[11px] leading-snug text-muted-foreground group-hover:text-accent-foreground/70">
                        {opt.description}
                      </p>
                    )}
                  </div>
                  {opt.value === value && (
                    <Check className="mt-0.5 size-3 shrink-0 text-accent group-hover:text-accent-foreground" />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
        {hoveredOpt?.description && (
          <div className="pointer-events-none absolute left-full top-1/2 z-50 ml-1.5 w-56 -translate-y-1/2 rounded-md border border-border/30 bg-muted/70 p-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] backdrop-blur-md">
            <p className="text-xs font-medium">{hoveredOpt.name}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {hoveredOpt.description}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
