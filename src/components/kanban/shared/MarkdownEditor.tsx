import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils.ts";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useSelectedProject } from "@/store/projectStore";
import { Bold, Code, Heading2, Info, Italic, Link, List, ListOrdered, Quote } from "lucide-react";

interface MarkdownEditorProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  placeholder?: string;
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function MarkdownEditor({
  value,
  onSave,
  isEditable,
  placeholder = "",
}: MarkdownEditorProps) {
  const project = useSelectedProject();
  const projectId = project?.id;

  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [activeTab, setActiveTab] = useState<"write" | "preview">("write");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const capturedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);

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

  // Restore cursor position after formatting helpers update `draft`
  useEffect(() => {
    if (pendingSelectionRef.current && textareaRef.current) {
      const { start, end } = pendingSelectionRef.current;
      textareaRef.current.setSelectionRange(start, end);
      pendingSelectionRef.current = null;
    }
  });

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
    setActiveTab("write");
    setEditing(true);
  }

  const commit = useCallback(() => {
    setEditing(false);
    setActiveTab("write");
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
  }, [draft, value, onSave]);

  // --- Formatting helpers ---

  function applyFormatting(newValue: string, newStart: number, newEnd: number) {
    pendingSelectionRef.current = { start: newStart, end: newEnd };
    setDraft(newValue);
  }

  function wrapSelection(before: string, after: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = draft.substring(start, end) || "text";
    const newValue = draft.substring(0, start) + before + selected + after + draft.substring(end);
    applyFormatting(newValue, start + before.length, start + before.length + selected.length);
  }

  function insertLinePrefix(prefix: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const firstLineStart = draft.lastIndexOf("\n", start - 1) + 1;
    const before = draft.substring(0, firstLineStart);
    const selected = draft.substring(firstLineStart, end);
    const after = draft.substring(end);
    const prefixed = selected.replace(/^/gm, prefix);
    const newValue = before + prefixed + after;
    applyFormatting(newValue, start + prefix.length, end + (prefixed.length - selected.length));
  }

  function insertHeading() {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const lineStart = draft.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = draft.indexOf("\n", start);
    const line = draft.substring(lineStart, lineEndIdx === -1 ? undefined : lineEndIdx);
    const match = line.match(/^(#{1,5}) /);
    if (match) {
      const newPrefix = "#".repeat(Math.min(match[1].length + 1, 6)) + " ";
      const cleaned = line.replace(/^#{1,6} /, "");
      const end = lineEndIdx === -1 ? draft.length : lineEndIdx;
      const newValue = draft.substring(0, lineStart) + newPrefix + cleaned + draft.substring(end);
      const delta = newPrefix.length - match[1].length - 1;
      applyFormatting(newValue, start + delta, start + delta);
    } else {
      const prefix = "## ";
      const newValue = draft.substring(0, lineStart) + prefix + draft.substring(lineStart);
      applyFormatting(newValue, start + prefix.length, start + prefix.length);
    }
  }

  function insertLink() {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = draft.substring(start, end);
    const link = selected ? `[${selected}](url)` : "[link text](url)";
    const newValue = draft.substring(0, start) + link + draft.substring(end);
    if (selected) {
      applyFormatting(newValue, start + selected.length + 3, start + selected.length + 6);
    } else {
      applyFormatting(newValue, start + 12, start + 15);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "b") {
      e.preventDefault();
      wrapSelection("**", "**");
    } else if (mod && e.key === "i") {
      e.preventDefault();
      wrapSelection("_", "_");
    } else if (mod && e.key === "k") {
      e.preventDefault();
      insertLink();
    } else if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
      setActiveTab("write");
    }
  }

  // Prevent toolbar/tab clicks from blurring the textarea
  function preventBlur(e: React.MouseEvent) {
    e.preventDefault();
  }

  // --- View mode ---
  if (!editing) {
    return (
      <div
        ref={viewRef}
        tabIndex={isEditable ? 0 : -1}
        onClick={() => isEditable && enterEdit()}
        onFocus={() => isEditable && enterEdit()}
        className={cn(
          "rounded px-1 py-0.5 min-h-[1.5em] text-sm leading-relaxed",
          isEditable && "border border-transparent hover:border-border cursor-text",
          !isEditable && "cursor-default",
          !value && "text-muted-foreground",
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

  // --- Edit mode ---
  return (
    <div className="flex flex-col rounded border border-ring overflow-hidden">
      {/* Header: tabs + toolbar */}
      <div className="flex items-stretch bg-muted/30 border-b border-border">
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={preventBlur}
          onClick={() => setActiveTab("write")}
          className={cn(
            "px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
            activeTab === "write"
              ? "text-foreground border-ring"
              : "text-muted-foreground border-transparent hover:text-foreground",
          )}
        >
          Write
        </button>
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={preventBlur}
          onClick={() => setActiveTab("preview")}
          className={cn(
            "px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
            activeTab === "preview"
              ? "text-foreground border-ring"
              : "text-muted-foreground border-transparent hover:text-foreground",
          )}
        >
          Preview
        </button>

        <div className="w-px bg-border mx-1 my-1.5 shrink-0" />

        {/* Toolbar */}
        <div
          className={cn(
            "flex items-center gap-0.5 px-1 flex-1",
            activeTab === "preview" && "opacity-40 pointer-events-none",
          )}
        >
          <ToolbarButton
            icon={Bold}
            label="Bold (⌘B)"
            onMouseDown={preventBlur}
            onClick={() => wrapSelection("**", "**")}
          />
          <ToolbarButton
            icon={Italic}
            label="Italic (⌘I)"
            onMouseDown={preventBlur}
            onClick={() => wrapSelection("_", "_")}
          />
          <ToolbarSep />
          <ToolbarButton
            icon={Heading2}
            label="Heading"
            onMouseDown={preventBlur}
            onClick={insertHeading}
          />
          <ToolbarButton
            icon={Quote}
            label="Quote"
            onMouseDown={preventBlur}
            onClick={() => insertLinePrefix("> ")}
          />
          <ToolbarSep />
          <ToolbarButton
            icon={Code}
            label="Inline code"
            onMouseDown={preventBlur}
            onClick={() => wrapSelection("`", "`")}
          />
          <ToolbarButton
            icon={List}
            label="Bullet list"
            onMouseDown={preventBlur}
            onClick={() => insertLinePrefix("- ")}
          />
          <ToolbarButton
            icon={ListOrdered}
            label="Numbered list"
            onMouseDown={preventBlur}
            onClick={() => insertLinePrefix("1. ")}
          />
          <ToolbarSep />
          <ToolbarButton
            icon={Link}
            label="Link (⌘K)"
            onMouseDown={preventBlur}
            onClick={insertLink}
          />
        </div>

        <span
          className="flex items-center gap-1 text-xs text-muted-foreground pr-2 select-none shrink-0"
          title="Markdown is rendered when not editing"
        >
          <Info className="size-3" />
          Markdown
        </span>
      </div>

      {/* Content area: textarea always in DOM, preview overlaid on top */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autoResize(e.target);
          }}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          placeholder={placeholder}
          className="w-full min-h-32 resize-none outline-none px-2 py-2 text-sm font-mono text-muted-foreground leading-relaxed bg-transparent"
        />
        {activeTab === "preview" && (
          <div
            onMouseDown={preventBlur}
            className="absolute inset-0 bg-background px-2 py-2 overflow-y-auto text-sm leading-relaxed"
          >
            {draft.trim() ? (
              <MarkdownBlock text={draft} projectId={projectId} />
            ) : (
              <span className="text-muted-foreground italic">Nothing to preview.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ToolbarButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: () => void;
}

function ToolbarButton({ icon: Icon, label, onMouseDown, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      title={label}
      onMouseDown={onMouseDown}
      onClick={onClick}
      className="flex items-center justify-center size-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent/10 transition-colors"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function ToolbarSep() {
  return <div className="w-px bg-border mx-1 h-4 shrink-0" />;
}
