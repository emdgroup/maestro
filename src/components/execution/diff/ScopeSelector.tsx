import { useState } from "react";
import { ChevronDown, Check, GitCompareArrows, FilePenLine, GitCommitVertical } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Checkbox } from "@/ui/checkbox";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { commitSpan, fillSpan, type DiffScope } from "./scope";
import type { CommitInfo } from "@/types/bindings";

export type { DiffScope };

interface ScopeSelectorProps {
  selectedScope: DiffScope;
  onScopeChange: (scope: DiffScope) => void;
  commits: CommitInfo[];
  uncommittedFileCount: number;
  /**
   * Files in the whole review, independent of what is selected. Pinned deliberately: this number
   * describes the "All changes" option, and a count that moved with the current scope made the
   * option look like it meant something different each time the menu opened.
   */
  allChangesFileCount: number;
  isLoading?: boolean;
}

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

function relativeTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatDistanceToNow(date, { addSuffix: true });
}

/** Says what kind of scope this is. An icon rather than a colour, which named nothing. */
function ScopeIcon({ scope, className }: { scope: DiffScope["type"]; className?: string }) {
  const Icon =
    scope === "all" ? GitCompareArrows : scope === "uncommitted" ? FilePenLine : GitCommitVertical;
  return <Icon className={cn("size-3.5 shrink-0", className)} />;
}

/**
 * A row in the scope list.
 *
 * Selection is carried by the accent *text* and the tick, leaving the accent fill to mean "the
 * pointer is here" — the same thing it means in every menu in the app (`dropdown-menu.tsx` uses
 * `focus:bg-accent focus:text-accent-foreground`). Filling the selected row instead left one row
 * permanently lit and, because the text stayed at `foreground` over an `oklch(50%)` accent in the
 * light theme, unreadable.
 */
function ScopeRow({
  gutter,
  title,
  subtitle,
  trailing,
  selected,
  onClick,
}: {
  gutter: React.ReactNode;
  title: string;
  subtitle: string;
  trailing?: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full flex items-start gap-2.5 px-3 py-2 text-left rounded-md transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      {/* `self-center`, against the row's `items-start`: the mark belongs to the whole card, so it
          sits on the card's centre line rather than beside the title. */}
      <span className="w-4 shrink-0 self-center flex items-center justify-center">{gutter}</span>
      <span className="flex-1 min-w-0">
        <span
          className={cn(
            "block text-xs font-medium leading-snug group-hover:text-accent-foreground",
            selected && "text-accent",
          )}
        >
          {title}
        </span>
        <span className="block text-[11px] mt-0.5 text-muted-foreground group-hover:text-accent-foreground/75">
          {subtitle}
        </span>
      </span>
      {trailing}
    </button>
  );
}

export function ScopeSelector({
  selectedScope,
  onScopeChange,
  commits,
  uncommittedFileCount,
  allChangesFileCount,
  isLoading,
}: ScopeSelectorProps) {
  const [open, setOpen] = useState(false);
  // Commits ticked while building a range, and the end the range grew from. Kept out of
  // `selectedScope` so an abandoned range leaves the current view alone.
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const draftSpan = commitSpan(draft, commits);

  function apply(scope: DiffScope) {
    onScopeChange(scope);
    clearDraft();
    setOpen(false);
  }

  function clearDraft() {
    setDraft(new Set());
    setAnchor(null);
  }

  /**
   * Shift-click semantics: the first tick sets one end of the range, the next sets the other and
   * fills everything between. Un-ticking the only selected commit clears.
   */
  function toggleCommit(sha: string) {
    if (!anchor) {
      setAnchor(sha);
      setDraft(new Set([sha]));
      return;
    }
    if (sha === anchor && draft.size === 1) {
      clearDraft();
      return;
    }
    setDraft(fillSpan(commits, anchor, sha));
  }

  function triggerLabel(): { title: string; detail: string } {
    switch (selectedScope.type) {
      case "all":
        return { title: "All changes", detail: `${allChangesFileCount} files` };
      case "uncommitted":
        return { title: "Uncommitted", detail: `${uncommittedFileCount} files` };
      case "commits": {
        const span = fillSpan(commits, selectedScope.oldest, selectedScope.newest);
        if (span.size > 1) {
          return {
            title: `${span.size} commits`,
            detail: `${shortSha(selectedScope.oldest)}…${shortSha(selectedScope.newest)}`,
          };
        }
        const commit = commits.find((c) => c.sha === selectedScope.newest);
        return {
          title: commit?.message || shortSha(selectedScope.newest),
          detail: shortSha(selectedScope.newest),
        };
      }
    }
  }

  const label = triggerLabel();
  const isCommitScope = selectedScope.type === "commits";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) clearDraft();
      }}
    >
      <PopoverTrigger
        className={cn(
          "flex items-center gap-2 h-8 px-2.5 rounded-md text-xs min-w-0 max-w-72",
          "border border-border bg-muted/50 hover:bg-muted transition-colors",
        )}
      >
        <ScopeIcon scope={selectedScope.type} className="text-muted-foreground" />
        <span className="truncate font-medium">{isLoading ? "Loading…" : label.title}</span>
        <span className="text-muted-foreground shrink-0">{isLoading ? "" : label.detail}</span>
        <ChevronDown className="size-3 text-muted-foreground shrink-0" />
      </PopoverTrigger>

      {/* Wider than the trigger on purpose: commit subjects get a second line instead of
          truncating, which is the whole reason these are cards rather than rows. */}
      <PopoverContent align="start" className="w-[430px] p-1 gap-0">
        <ScopeRow
          gutter={
            selectedScope.type === "all" ? (
              <Check className="size-3.5 text-accent group-hover:text-accent-foreground" />
            ) : null
          }
          title="All changes"
          subtitle={`${allChangesFileCount} files · ${commits.length} commits`}
          selected={selectedScope.type === "all"}
          onClick={() => apply({ type: "all" })}
        />
        <ScopeRow
          gutter={
            selectedScope.type === "uncommitted" ? (
              <Check className="size-3.5 text-accent group-hover:text-accent-foreground" />
            ) : null
          }
          title="Uncommitted"
          subtitle={`${uncommittedFileCount} files`}
          selected={selectedScope.type === "uncommitted"}
          onClick={() => apply({ type: "uncommitted" })}
        />

        {commits.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
              SELECT A RANGE OF COMMITS
            </div>
            <div className="max-h-64 overflow-y-auto custom-scrollbar">
              {commits.map((commit) => {
                const inDraft = draft.has(commit.sha);
                const isCurrent =
                  isCommitScope &&
                  !draft.size &&
                  fillSpan(commits, selectedScope.oldest, selectedScope.newest).has(commit.sha);
                return (
                  <ScopeRow
                    key={commit.sha}
                    gutter={
                      <Checkbox
                        // Ticked for the scope in force as well as for a range being drafted, so
                        // the boxes always show which commits the diff on screen covers.
                        checked={inDraft || isCurrent}
                        onCheckedChange={() => toggleCommit(commit.sha)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Include ${shortSha(commit.sha)} in the range`}
                        // Over a hovered row the fill is already accent, so a checked box would
                        // vanish into it — swap the two on hover instead.
                        className="group-hover:border-accent-foreground group-hover:data-checked:bg-accent-foreground group-hover:data-checked:text-accent"
                        tabIndex={-1}
                      />
                    }
                    title={commit.message || shortSha(commit.sha)}
                    subtitle={relativeTime(commit.committed_at)}
                    trailing={
                      <span
                        className={cn(
                          "font-mono text-[11px] shrink-0 pt-0.5 group-hover:text-accent-foreground/75",
                          isCurrent ? "text-accent" : "text-muted-foreground",
                        )}
                      >
                        {shortSha(commit.sha)}
                      </span>
                    }
                    selected={isCurrent}
                    onClick={() =>
                      apply({ type: "commits", oldest: commit.sha, newest: commit.sha })
                    }
                  />
                );
              })}
            </div>
          </>
        )}

        {/* Only while a range is being built — picking one scope stays a single click. */}
        {draftSpan && (
          <div className="flex items-center gap-2 mt-1 px-2 py-2 border-t border-border">
            <span className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate">
              {draft.size} commit{draft.size === 1 ? "" : "s"} ·{" "}
              <span className="font-mono">
                {shortSha(draftSpan.oldest)}…{shortSha(draftSpan.newest)}
              </span>
            </span>
            <Button variant="outline" size="sm" onClick={clearDraft}>
              Clear
            </Button>
            <Button size="sm" onClick={() => apply({ type: "commits", ...draftSpan })}>
              Apply
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
