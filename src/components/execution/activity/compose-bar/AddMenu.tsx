import { useState, type KeyboardEvent } from "react";
import { BookText, ChevronLeft, ChevronRight, Paperclip, Plus, Search, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePromptsQuery } from "@/services/prompt.service";
import type { Prompt } from "@/types/bindings";
import { GLASS_CONTENT_CLASS } from "../config-selectors/BaseDropdownSelector";

interface Props {
  disabled: boolean;
  /** The session's project, whose prompt collection is listed beside the shared one. */
  projectId: number | null;
  onAttach: () => void;
  onInsertPrompt: (body: string) => void;
}

const ROW_CLASS =
  "w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-foreground/7 focus-visible:bg-foreground/7";

/** The compose bar's "+": attach files, or put a saved prompt in the box. */
export function AddMenu({ disabled, projectId, onAttach, onInsertPrompt }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "prompts">("menu");

  const close = () => {
    setOpen(false);
    setView("menu");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // Escape in the picker steps back to the menu rather than closing both.
        if (!next && details.reason === "escape-key" && view === "prompts") {
          setView("menu");
          return;
        }
        if (next) setOpen(true);
        else close();
      }}
    >
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          <PopoverTrigger
            disabled={disabled}
            aria-label="Add to message"
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground border border-transparent hover:border-border/40 hover:text-accent hover:bg-accent/8 disabled:opacity-20 disabled:cursor-not-allowed transition-all duration-150",
              open && "text-accent bg-accent/8",
            )}
          >
            <Plus
              className={cn("w-4 h-4 transition-transform duration-150", open && "rotate-45")}
            />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Attach files or insert a prompt</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className={cn(GLASS_CONTENT_CLASS, "gap-0 p-0", view === "menu" ? "w-60" : "w-140")}
      >
        {view === "menu" ? (
          <div
            role="menu"
            className="p-1"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const items = [...e.currentTarget.querySelectorAll("button")];
              const i = items.indexOf(document.activeElement as HTMLButtonElement);
              const step = e.key === "ArrowDown" ? 1 : items.length - 1;
              items[(i + step) % items.length]?.focus();
            }}
          >
            <button
              type="button"
              role="menuitem"
              autoFocus
              className={ROW_CLASS}
              onClick={() => {
                close();
                onAttach();
              }}
            >
              <Paperclip className="w-4 h-4 text-muted-foreground" />
              <span className="flex-1">Attach files</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={ROW_CLASS}
              onClick={() => setView("prompts")}
            >
              <BookText className="w-4 h-4 text-muted-foreground" />
              <span className="flex-1">Insert prompt</span>
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        ) : (
          <PromptPicker
            projectId={projectId}
            onBack={() => setView("menu")}
            onPick={(prompt) => {
              close();
              onInsertPrompt(prompt.body);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function PromptPicker({
  projectId,
  onBack,
  onPick,
}: {
  projectId: number | null;
  onBack: () => void;
  onPick: (prompt: Prompt) => void;
}) {
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const project = usePromptsQuery(projectId, false);
  const shared = usePromptsQuery(projectId, true);

  const q = search.trim().toLowerCase();
  const matches = (p: Prompt) =>
    !q || p.title.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q));
  // The backend already orders each collection favorites first, then newest.
  const groups = [
    { label: "This project", prompts: (project.data ?? []).filter(matches) },
    { label: "Shared", prompts: (shared.data ?? []).filter(matches) },
  ].filter((g) => g.prompts.length > 0);
  const flat = groups.flatMap((g) => g.prompts);
  const current = flat[Math.min(highlight, flat.length - 1)];
  const loading = project.isLoading || shared.isLoading;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      onPick(current);
    }
  };

  let index = 0;
  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1.5 border-b border-border/30 px-1.5 py-1.5">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-foreground/7 hover:text-foreground"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <Search className="size-3 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setHighlight(0);
          }}
          placeholder="Search prompts by title or tag"
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex h-64">
        <div className="w-[46%] shrink-0 overflow-y-auto border-r border-border/20 p-1">
          {flat.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {loading ? "Loading prompts…" : q ? "No prompts match" : "No saved prompts yet"}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </div>
              {group.prompts.map((prompt) => {
                const i = index++;
                return (
                  <button
                    key={`${group.label}-${prompt.id}`}
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => onPick(prompt)}
                    className={cn(
                      "w-full flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm",
                      prompt === current ? "bg-foreground/7 text-foreground" : "text-foreground/80",
                    )}
                  >
                    <span className="truncate">{prompt.title}</span>
                    {prompt.favorite && (
                      <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto p-3">
          {current && (
            <>
              <p className="mb-1.5 truncate text-sm font-medium">{current.title}</p>
              <div className="mb-2 flex flex-wrap gap-1">
                {current.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-foreground/7 px-1.5 py-px text-[10px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
                <span className="rounded-full border border-border/60 px-1.5 py-px text-[10px] text-muted-foreground">
                  {current.shared ? "Shared" : "Project"}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {current.body}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-border/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>↑↓ move</span>
        <span>Enter insert</span>
        <span>Esc back</span>
      </div>
    </div>
  );
}
