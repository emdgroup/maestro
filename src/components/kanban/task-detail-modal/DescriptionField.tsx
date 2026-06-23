import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/ui-utils";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";

interface DescriptionFieldProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  placeholder?: string;
  projectId?: number;
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function DescriptionField({
  value,
  onSave,
  isEditable,
  placeholder = "",
  projectId,
}: DescriptionFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      autoResize(textareaRef.current);
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
  }, [draft, value, onSave]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autoResize(e.target);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn(
          "w-full min-h-20 resize-none overflow-hidden outline-none rounded px-1 py-0.5",
          "text-sm text-muted-foreground leading-relaxed",
          "ring-1 ring-ring bg-transparent",
        )}
      />
    );
  }

  if (value) {
    return (
      <div
        onClick={() => isEditable && setEditing(true)}
        className={cn(
          "rounded px-1 py-0.5 min-h-[1.5em] text-sm leading-relaxed",
          isEditable && "hover:ring-1 hover:ring-border cursor-text",
          !isEditable && "cursor-default",
        )}
      >
        <MarkdownBlock text={value} projectId={projectId} />
      </div>
    );
  }

  return (
    <div
      onClick={() => isEditable && setEditing(true)}
      className={cn(
        "rounded px-1 py-0.5 min-h-[1.5em] text-sm text-muted-foreground leading-relaxed",
        isEditable && "hover:ring-1 hover:ring-border cursor-text",
        !isEditable && "cursor-default",
      )}
    >
      {isEditable ? placeholder : ""}
    </div>
  );
}
