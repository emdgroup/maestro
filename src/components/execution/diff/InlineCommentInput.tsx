import { useState, useRef, useEffect } from "react";
import { Button } from "@/ui/button";

interface InlineCommentInputProps {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
}

export function InlineCommentInput({ onSubmit, onCancel, initialText }: InlineCommentInputProps) {
  const [text, setText] = useState(initialText ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleSubmit() {
    if (text.trim()) {
      onSubmit(text.trim());
      setText("");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  }

  return (
    <div className="mx-4 my-2 rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment..."
        className="w-full min-h-[60px] resize-y bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        rows={2}
      />
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="ghost" size="sm" onClick={onCancel} style={{ color: "var(--foreground)" }}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!text.trim()} style={{ color: "var(--primary-foreground)" }}>
          {initialText ? "Save" : "Add"}
        </Button>
      </div>
    </div>
  );
}
