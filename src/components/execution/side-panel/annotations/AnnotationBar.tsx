import { useState } from "react";
import { Send, Pencil, Trash2, Check, X } from "lucide-react";
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
  const quote = a.quote.replace(/\s+/g, " ");
  return quote.length > 40 ? `“${quote.slice(0, 40)}…”` : `“${quote}”`;
}

interface AnnotationBarProps {
  sessionKey: number;
  kind: Annotation["kind"];
  onSend: (annotations: Annotation[]) => void;
  sendDisabled?: boolean;
  /** Overlay in the corner of a pane with no top bar (Plan) instead of sitting in a header. */
  floating?: boolean;
}

export function AnnotationBar({
  sessionKey,
  kind,
  onSend,
  sendDisabled,
  floating,
}: AnnotationBarProps) {
  const annotations = useSessionAnnotations(sessionKey, kind);
  const [open, setOpen] = useState(false);

  if (annotations.length === 0) return null;

  const sendTitle = sendDisabled ? "Agent is busy" : "Send all annotations to this session";

  return (
    <div
      className={cn(
        "flex items-center shrink-0",
        floating &&
          "absolute top-2 right-3 z-20 rounded-md bg-card/90 backdrop-blur-sm shadow-sm transition-opacity hover:opacity-100 focus-within:opacity-100",
        floating && (open ? "opacity-100" : "opacity-50"),
      )}
    >
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
}: {
  sessionKey: number;
  annotations: Annotation[];
  onSend: (annotations: Annotation[]) => void;
  sendDisabled?: boolean;
}) {
  const { updateAnnotation, removeAnnotations } = useAnnotationStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-border">
        {annotations.map((a) => (
          <div key={a.id} className="flex items-start gap-2 px-3 py-2">
            <Checkbox
              className="mt-0.5"
              checked={selected.has(a.id)}
              onCheckedChange={() => toggle(a.id)}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-mono text-muted-foreground truncate">
                {annotationLabel(a)}
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
