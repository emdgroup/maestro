import { useState } from "react";
import { CopyPlus, Ellipsis, Pencil, Plus, Search, Star, Trash2 } from "lucide-react";
import {
  DragDropProvider,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  useCopyPromptMutation,
  useDeletePromptMutation,
  usePromptsQuery,
  useSetPromptFavoriteMutation,
} from "@/services/prompt.service";
import { PromptEditorDialog } from "./PromptEditorDialog";
import { allTags, filterPrompts, type PromptFilter } from "./prompts";
import type { Prompt } from "@/types/bindings";

const FILTERS: { value: PromptFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "favorites", label: "Favorites" },
];

type Collection = "project" | "shared";
const collectionOf = (shared: boolean): Collection => (shared ? "shared" : "project");

const COLLECTIONS: Record<
  Collection,
  { title: string; where: string; copyTo: string; drop: string; empty: string }
> = {
  project: {
    title: "This project",
    where: "Stored in the project's daemon. Every app opening this project sees them.",
    copyTo: "Copy to this project",
    drop: "Drop to copy into this project",
    empty: "No prompts in this project yet.",
  },
  shared: {
    title: "Shared",
    where: "Stored in this app. Available in every project this app opens.",
    copyTo: "Copy to shared",
    drop: "Drop to copy into shared",
    empty: "No shared prompts yet.",
  },
};

function copy(prompt: Prompt) {
  navigator.clipboard.writeText(prompt.body).then(
    () => toast.success(`Copied “${prompt.title}”`),
    () => toast.error("Could not copy to the clipboard"),
  );
}

function PromptCard({
  prompt,
  onFavorite,
  onCopyAcross,
  onEdit,
  onDelete,
}: {
  prompt: Prompt;
  onFavorite: () => void;
  onCopyAcross: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const collection = collectionOf(prompt.shared);
  // Dragged by the button laid over the card: the pointer sensor will not start on any other
  // control inside it, which keeps the star and the menu clickable.
  const { ref, handleRef, isDragging } = useDraggable({
    id: `${collection}-${prompt.id}`,
    type: collection,
    data: prompt,
  });
  return (
    <div
      ref={ref}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-accent/60 hover:bg-muted/30",
        isDragging && "border-dashed opacity-30",
      )}
    >
      {/* The whole card copies, laid over it so the star and the menu can sit inside without
          nesting one control in another. */}
      <button
        ref={handleRef}
        type="button"
        onClick={() => copy(prompt)}
        aria-label={`Copy “${prompt.title}”`}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onFavorite}
          aria-label={prompt.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={prompt.favorite}
          className={cn(
            "relative shrink-0",
            prompt.favorite
              ? "text-amber-500"
              : "text-muted-foreground/40 hover:text-muted-foreground",
          )}
        >
          <Star className={cn("size-4", prompt.favorite && "fill-current")} />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{prompt.title}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More actions for ${prompt.title}`}
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative -my-1 size-7 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto whitespace-nowrap">
            {/* The keyboard's way to do what a drag onto the other column does. */}
            <DropdownMenuItem className="text-xs" onClick={onCopyAcross}>
              <CopyPlus className="size-3.5" />
              {COLLECTIONS[collectionOf(!prompt.shared)].copyTo}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onClick={onEdit}>
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" className="text-xs" onClick={onDelete}>
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="line-clamp-4 flex-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
        {prompt.body}
      </p>
      {prompt.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {prompt.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One collection, scrolling on its own like a board column. It accepts only the other column's
 * cards, so it lights up for a drop that copies and never for one that would go nowhere. Drawn
 * when empty too, since that is when a drop is the likeliest way to fill it.
 */
function PromptColumn({
  collection,
  query,
  prompts,
  filtered,
  onNew,
  card,
}: {
  collection: Collection;
  query: UseQueryResult<Prompt[]>;
  /** What the search, filter and tag leave of the collection. */
  prompts: Prompt[];
  filtered: boolean;
  onNew: () => void;
  card: (prompt: Prompt) => React.ReactNode;
}) {
  const { title, where, drop, empty } = COLLECTIONS[collection];
  const { ref, isDropTarget } = useDroppable({
    id: collection,
    type: "collection",
    accept: collection === "shared" ? "project" : "shared",
  });
  return (
    <section
      aria-label={title}
      className={cn(
        "flex min-h-64 flex-col overflow-hidden rounded-lg border border-border bg-background transition-colors sm:min-h-0",
        isDropTarget && "border-accent ring-2 ring-accent/40",
      )}
    >
      <header className="flex items-start gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {title}
            <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {query.data?.length ?? 0}
            </span>
          </h3>
          {/* Live, so a drag over the column is announced as well as drawn. */}
          <p
            aria-live="polite"
            className={cn(
              "text-[11px] leading-snug",
              isDropTarget ? "font-medium text-accent" : "text-muted-foreground",
            )}
          >
            {isDropTarget ? drop : where}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`New prompt in ${title.toLowerCase()}`}
          className="-my-1 text-muted-foreground"
          onClick={onNew}
        >
          <Plus className="size-4" />
        </Button>
      </header>
      <div
        ref={ref}
        data-testid={`prompts-${collection}`}
        className={cn(
          "flex-1 overflow-y-auto p-3 transition-colors",
          isDropTarget && "bg-accent/10",
        )}
      >
        {query.isError ? (
          <div className="flex flex-col items-center gap-2 p-5 text-center">
            <p className="text-xs text-destructive">{String(query.error)}</p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : query.isPending ? null : prompts.length === 0 ? (
          <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
            {filtered && query.data.length > 0 ? (
              <p>No prompt matches.</p>
            ) : (
              <>
                <p className="font-medium">{empty}</p>
                <p className="text-muted-foreground/70">
                  Create one, or drag one here from the other collection.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
            {prompts.map(card)}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The project's prompts and the shared ones, in two columns that copy into each other by drag or
 * by menu. Favorites come first in each, in the order the backend returns them. The editor's open
 * state is held by the view, because the button that opens it for a new prompt lives in the view's
 * action bar.
 */
export function PromptsPanel({
  projectId,
  editorOpen,
  onEditorOpenChange,
  editing,
  newShared,
  onEdit,
  onNew,
}: {
  projectId: number;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  editing: Prompt | null;
  /** The collection a new prompt goes to. */
  newShared: boolean;
  onEdit: (prompt: Prompt) => void;
  onNew: (shared: boolean) => void;
}) {
  const projectPrompts = usePromptsQuery(projectId, false);
  const sharedPrompts = usePromptsQuery(projectId, true);
  const setFavorite = useSetPromptFavoriteMutation();
  const copyTo = useCopyPromptMutation();
  const remove = useDeletePromptMutation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PromptFilter>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Prompt | null>(null);
  const [dragging, setDragging] = useState<Prompt | null>(null);

  const tags = allTags([...(projectPrompts.data ?? []), ...(sharedPrompts.data ?? [])]);
  // A tag whose last prompt was deleted or retagged would otherwise filter everything away.
  const activeTag = tag !== null && tags.includes(tag) ? tag : null;
  const filtered = filter !== "all" || activeTag !== null || query.trim() !== "";

  const copyAcross = (prompt: Prompt) =>
    copyTo.mutate({ projectId, id: prompt.id, shared: prompt.shared });

  const card = (prompt: Prompt) => (
    <PromptCard
      key={`${collectionOf(prompt.shared)}-${prompt.id}`}
      prompt={prompt}
      onFavorite={() =>
        setFavorite.mutate({
          projectId,
          id: prompt.id,
          shared: prompt.shared,
          favorite: !prompt.favorite,
        })
      }
      onCopyAcross={() => copyAcross(prompt)}
      onEdit={() => onEdit(prompt)}
      onDelete={() => setDeleting(prompt)}
    />
  );

  return (
    <div className="mr-[7px] flex h-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-t-xl border-x border-t border-border bg-background p-4 sm:overflow-hidden">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search prompts…"
            aria-label="Search prompts"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <ToggleGroup
          value={[filter]}
          onValueChange={(values) => {
            const next = values.find((value) => value !== filter);
            if (next) setFilter(next as PromptFilter);
          }}
          aria-label="Show"
        >
          {FILTERS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              size="sm"
              variant="outline"
              className="text-xs"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by tag">
          {tags.map((known) => (
            <button
              key={known}
              type="button"
              aria-pressed={activeTag === known}
              onClick={() => setTag(activeTag === known ? null : known)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px]",
                activeTag === known
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/50",
              )}
            >
              {known}
            </button>
          ))}
        </div>
      )}

      {/* Pointer only: Enter on a card copies its text, and the menu is the keyboard's copy. */}
      <DragDropProvider
        sensors={[PointerSensor]}
        onDragStart={(event) => setDragging((event.operation.source?.data as Prompt) ?? null)}
        onDragEnd={(event) => {
          setDragging(null);
          const prompt = event.operation.source?.data as Prompt | undefined;
          // Each column accepts only the other's cards, so any target is the other collection.
          if (!event.canceled && prompt && event.operation.target) copyAcross(prompt);
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:min-h-0 sm:flex-1 sm:grid-cols-2">
          <PromptColumn
            collection="project"
            query={projectPrompts}
            prompts={filterPrompts(projectPrompts.data ?? [], filter, activeTag, query)}
            filtered={filtered}
            onNew={() => onNew(false)}
            card={card}
          />
          <PromptColumn
            collection="shared"
            query={sharedPrompts}
            prompts={filterPrompts(sharedPrompts.data ?? [], filter, activeTag, query)}
            filtered={filtered}
            onNew={() => onNew(true)}
            card={card}
          />
        </div>
        <DragOverlay>
          {dragging && (
            <div className="pointer-events-none rotate-[-1.5deg] scale-[1.03] rounded-xl border border-accent/50 bg-card p-3 shadow-xl">
              <p className="line-clamp-2 text-sm font-semibold">{dragging.title}</p>
            </div>
          )}
        </DragOverlay>
      </DragDropProvider>

      <PromptEditorDialog
        open={editorOpen}
        onOpenChange={onEditorOpenChange}
        projectId={projectId}
        editing={editing}
        newShared={newShared}
        knownTags={tags}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.shared
                ? "It leaves the shared collection, so it disappears from every project this app opens."
                : "It leaves this project's collection, for every app that opens the project."}{" "}
              Copies in the other collection stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  const title = deleting.title;
                  remove.mutate(
                    { projectId, id: deleting.id, shared: deleting.shared },
                    {
                      onSuccess: () => toast.success(`Deleted “${title}”`),
                    },
                  );
                }
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
