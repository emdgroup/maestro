import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/ui-utils";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useSelectedProject } from "@/store/projectStore";

interface EditableFieldProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function EditableField({
  value,
  onSave,
  isEditable,
  placeholder = "",
  className,
  multiline = false,
}: EditableFieldProps) {
  const project = useSelectedProject();
  const projectId = project?.id;
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const capturedSizeRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      if (capturedSizeRef.current !== null) {
        textareaRef.current.style.width = `${capturedSizeRef.current.width}px`;
        textareaRef.current.style.height = `${capturedSizeRef.current.height}px`;
        capturedSizeRef.current = null;
      } else {
        autoResize(textareaRef.current);
      }
    }
  }, [editing]);

  function enterEdit() {
    const el = viewRef.current;
    if (el) {
      const availableHeight = (el.parentElement?.clientHeight ?? el.offsetHeight) - 6;
      capturedSizeRef.current = {
        width: el.offsetWidth,
        height: Math.min(el.offsetHeight, availableHeight),
      };
    } else {
      capturedSizeRef.current = null;
    }
    setEditing(true);
  }

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
  }, [draft, value, onSave]);

  const viewClass = cn(
    "rounded px-1 py-0.5 min-h-[1.5em]",
    isEditable && "border border-transparent hover:border-border cursor-text",
    !isEditable && "cursor-default",
  );

  if (multiline) {
    if (editing) {
      return (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          className={cn(
            "w-full min-h-13 resize-none overflow-y-auto outline-none rounded px-1 py-0.5",
            "text-sm text-muted-foreground leading-relaxed",
            "border border-ring bg-transparent",
            className,
          )}
        />
      );
    }

    return (
      <div
        ref={viewRef}
        tabIndex={isEditable ? 0 : -1}
        onClick={() => isEditable && enterEdit()}
        onFocus={() => isEditable && enterEdit()}
        className={cn(
          viewClass,
          "text-sm leading-relaxed",
          !value && "text-muted-foreground",
          className,
        )}
      >
        {value ? (
          <MarkdownBlock text={value} projectId={projectId} />
        ) : isEditable ? (
          placeholder
        ) : (
          ""
        )}
      </div>
    );
  }

  return (
    <input
      type="text"
      value={draft}
      readOnly={!isEditable}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed !== value) onSave(trimmed);
      }}
      className={cn(
        "w-full bg-transparent outline-none rounded px-1 min-h-[1.5em]",
        isEditable && "hover:ring-1 hover:ring-border focus:ring-1 focus:ring-ring cursor-text",
        !isEditable && "cursor-default",
        className,
      )}
    />
  );
}
