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
            "w-full min-h-13 resize-none overflow-hidden outline-none rounded px-1 py-0.5",
            "text-sm text-muted-foreground leading-relaxed",
            "border border-ring bg-transparent",
            className,
          )}
        />
      );
    }

    return (
      <div
        tabIndex={isEditable ? 0 : -1}
        onClick={() => isEditable && setEditing(true)}
        onFocus={() => isEditable && setEditing(true)}
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
