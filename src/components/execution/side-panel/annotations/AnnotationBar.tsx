import { useEffect, useRef, useState } from "react";
import { Send, Pencil, Trash2, Check, X, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Checkbox } from "@/ui/checkbox";
import { Button } from "@/ui/button";
import { useAnnotationStore, useSessionAnnotations } from "@/store/annotationStore";
import type { Annotation } from "@/store/annotationStore";

export function annotationLabel(a: Annotation): string {
  if (a.kind === "diff") {
    const base = a.filePath.split("/").pop() ?? a.filePath;
    return a.lineNumber > 0 ? `${base}:${a.lineNumber}` : base;
  }
  if (a.kind === "canvas") {
    // The surface names the place, the ids name the thing — a note with neither is one taken on
    // empty space, which is a comment about the layout and has only the surface to point at.
    const [first, ...rest] = a.componentIds;
    if (!first) return a.surfaceTitle;
    return `${a.surfaceTitle} · ${first}${rest.length > 0 ? ` +${rest.length}` : ""}`;
  }
  const quote = a.quote.replace(/\s+/g, " ");
  return quote.length > 40 ? `“${quote.slice(0, 40)}…”` : `“${quote}”`;
}

interface AnnotationBarProps {
  sessionKey: number;
  kind: Annotation["kind"];
  onSend: (annotations: Annotation[]) => void;
  sendDisabled?: boolean;
  /**
   * Reveal the annotation at `id` in its host view. Supplying it turns the list into a
   * navigator — rows become clickable and the header grows chevrons. Left unset by hosts with
   * no notion of a location to travel to, which is why the diff bar looks unchanged.
   */
  onGoTo?: (id: string) => void;
  /** Which annotation the host is currently showing, marked as selected in the list. */
  activeId?: string | null;
  /**
   * The thing this annotation was left on is gone — the agent rewrote it. Such a note is dimmed
   * rather than dropped: it can still be read, and it can still be sent, since its text says what
   * it said. Only hosts with a notion of an anchor that can rot supply this.
   */
  isStale?: (a: Annotation) => boolean;
}

export function AnnotationBar({
  sessionKey,
  kind,
  onSend,
  sendDisabled,
  onGoTo,
  activeId,
  isStale,
}: AnnotationBarProps) {
  const annotations = useSessionAnnotations(sessionKey, kind);
  const [open, setOpen] = useState(false);

  if (annotations.length === 0) return null;

  const sendTitle = sendDisabled ? "Agent is busy" : "Send all annotations to this session";

  return (
    <div className="flex items-center shrink-0">
      <div className="flex items-center rounded-md border border-accent overflow-hidden text-xs">
        <Tooltip>
          <TooltipTrigger
            type="button"
            disabled={sendDisabled}
            aria-disabled={sendDisabled}
            // Guarded here as well: the trigger keeps its click handler when disabled, and a
            // silent no-op send is worse than a dead button.
            onClick={() => {
              if (!sendDisabled) onSend(annotations);
            }}
            className="px-2 py-1 bg-accent text-accent-foreground font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Send annotations
          </TooltipTrigger>
          <TooltipContent>{sendTitle}</TooltipContent>
        </Tooltip>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="px-2 py-1 text-accent border-l border-accent hover:bg-accent/10 transition-colors">
            {annotations.length}
          </PopoverTrigger>
          <AnnotationListPanel
            sessionKey={sessionKey}
            annotations={annotations}
            onSend={onSend}
            sendDisabled={sendDisabled}
            onGoTo={onGoTo}
            activeId={activeId}
            isStale={isStale}
          />
        </Popover>
      </div>
    </div>
  );
}

function AnnotationListPanel({
  sessionKey,
  annotations,
  onSend,
  sendDisabled,
  onGoTo,
  activeId,
  isStale,
}: {
  sessionKey: number;
  annotations: Annotation[];
  onSend: (annotations: Annotation[]) => void;
  sendDisabled?: boolean;
  onGoTo?: (id: string) => void;
  activeId?: string | null;
  isStale?: (a: Annotation) => boolean;
}) {
  const { updateAnnotation, removeAnnotations } = useAnnotationStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const activeRowRef = useRef<HTMLDivElement>(null);

  // Stepping with a chevron has to look like clicking the row, so the selection is not a second
  // piece of state: both call `onGoTo`, the host moves `activeId`, and the row follows. All this
  // adds is keeping that row on screen when the list is longer than the popup.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const step = (delta: 1 | -1) => {
    if (!onGoTo || annotations.length === 0) return;
    const current = annotations.findIndex((a) => a.id === activeId);
    const from = current >= 0 ? current : delta === 1 ? -1 : 0;
    onGoTo(annotations[(from + delta + annotations.length) % annotations.length].id);
  };

  const selectedAnnotations = annotations.filter((a) => selected.has(a.id));

  return (
    <PopoverContent align="end" side="bottom" className="w-84 p-0 gap-0 max-h-96 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Checkbox
          checked={selected.size === annotations.length && annotations.length > 0}
          indeterminate={selected.size > 0 && selected.size < annotations.length}
          onCheckedChange={(checked) =>
            setSelected(checked ? new Set(annotations.map((a) => a.id)) : new Set())
          }
        />
        <span className="text-xs text-muted-foreground">
          {selected.size > 0 ? `${selected.size} selected` : `${annotations.length} annotations`}
        </span>
        {onGoTo && annotations.length > 1 && (
          <div className="flex items-center gap-0.5 ml-auto">
            <Button
              variant="ghost"
              size="icon-xs"
              title="Previous annotation"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => step(-1)}
            >
              <ChevronUp className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Next annotation"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => step(1)}
            >
              <ChevronDown className="size-3" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-border">
        {annotations.map((a) => (
          <div
            key={a.id}
            ref={a.id === activeId ? activeRowRef : undefined}
            className={cn(
              "flex items-start gap-2 px-3 py-2 transition-colors",
              a.id === activeId && "bg-accent/12 shadow-[inset_2px_0_0] shadow-accent",
              isStale?.(a) && "opacity-55",
            )}
          >
            <Checkbox
              className="mt-0.5"
              checked={selected.has(a.id)}
              onCheckedChange={() => toggle(a.id)}
            />
            {/* Only the label and text travel — the checkbox and the actions beside them keep
                their own jobs, so clicking either must not also move the view. */}
            <div
              className={cn("flex-1 min-w-0", onGoTo && "cursor-pointer")}
              onClick={onGoTo ? () => onGoTo(a.id) : undefined}
            >
              <div className="text-[10px] font-mono text-muted-foreground truncate">
                {annotationLabel(a)}
                {isStale?.(a) && <span className="ml-1 italic">— gone</span>}
              </div>
              {editingId === a.id ? (
                <div className="flex flex-col gap-1 mt-1">
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingId(null);
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        if (draft.trim()) updateAnnotation(sessionKey, a.id, draft.trim());
                        setEditingId(null);
                      }
                    }}
                    rows={2}
                    className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-accent"
                  />
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setEditingId(null)}
                      title="Cancel"
                    >
                      <X className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={!draft.trim()}
                      title="Save"
                      onClick={() => {
                        updateAnnotation(sessionKey, a.id, draft.trim());
                        setEditingId(null);
                      }}
                    >
                      <Check className="size-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
                  {a.text}
                </p>
              )}
            </div>
            {editingId !== a.id && (
              <div className="flex items-center gap-0.5 shrink-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={sendDisabled ? "Agent is busy" : "Send this annotation"}
                  disabled={sendDisabled}
                  className="text-muted-foreground hover:text-accent"
                  onClick={() => onSend([a])}
                >
                  <Send className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Edit"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setDraft(a.text);
                    setEditingId(a.id);
                  }}
                >
                  <Pencil className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Delete"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeAnnotations(sessionKey, [a.id])}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
          <Button
            size="sm"
            className="h-6 text-xs flex-1"
            disabled={sendDisabled}
            onClick={() => {
              onSend(selectedAnnotations);
              setSelected(new Set());
            }}
          >
            Send selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => {
              removeAnnotations(sessionKey, [...selected]);
              setSelected(new Set());
            }}
          >
            Delete
          </Button>
        </div>
      )}
    </PopoverContent>
  );
}
