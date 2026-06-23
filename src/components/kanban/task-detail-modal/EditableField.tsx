import { useRef, useEffect } from "react";
import { cn } from "@/lib/ui-utils";

interface EditableFieldProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  placeholder?: string;
  className?: string;
}

export function EditableField({
  value,
  onSave,
  isEditable,
  placeholder = "",
  className,
}: EditableFieldProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (ref.current && !isEditingRef.current) {
      ref.current.innerText = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      contentEditable={isEditable}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onFocus={() => {
        isEditingRef.current = true;
      }}
      onBlur={() => {
        isEditingRef.current = false;
        const text = ref.current?.innerText.trim() ?? "";
        if (text !== value) onSave(text);
      }}
      className={cn(
        "outline-none rounded px-1 min-h-[1.5em]",
        isEditable && "hover:ring-1 hover:ring-border focus:ring-1 focus:ring-ring cursor-text",
        !isEditable && "cursor-default",
        "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground",
        className,
      )}
    />
  );
}
