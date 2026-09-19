import { useState, useEffect, useRef, useMemo, useContext } from "react";
import { ListPlus } from "lucide-react";
import type { MessageItem } from "./types";
import { MarkdownBlock, getCompleteBlocksText } from "./MarkdownBlock";
import { MessageActionBar } from "./MessageActionBar";
import { splitAtSectionStarts } from "./markdown-stream-utils";
import { CreateTaskFromTextContext } from "./task-draft";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

export { getCompleteBlocksText } from "./MarkdownBlock";

interface ActivityMessageItemProps {
  message: MessageItem;
  /**
   * The bar reserves a row, so a message with tool calls after it would wedge that row into
   * the middle of one agent reply. Only the message that closes a reply carries it.
   */
  showActions?: boolean;
}

export function TypingDots({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 align-middle${className ? ` ${className}` : ""}`}
      aria-label="typing"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1 h-1 rounded-full bg-foreground/50"
          style={{ animation: `typing-dot 1.2s ease-in-out ${i * 0.2}s infinite` }}
        />
      ))}
    </span>
  );
}

/**
 * The selected text, when the selection lies inside `element`. `null` otherwise, including for a
 * caret with nothing selected — "create a task from this message" is the sensible fallback, and a
 * stray click inside the message must not turn into an empty draft.
 */
function selectionWithin(element: HTMLElement | null): string | null {
  if (!element) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().trim();
  return text.length > 0 ? text : null;
}

export function ActivityMessageItem({ message, showActions }: ActivityMessageItemProps) {
  const createTaskFromText = useContext(CreateTaskFromTextContext);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastTextRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const [recentlyStreamed, setRecentlyStreamed] = useState(false);
  // Read when the tooltip opens rather than tracked: the selection is browser-owned, and the
  // label only has to be right at the moment it is shown.
  const [hasSelection, setHasSelection] = useState(false);
  // The poll below only runs while streaming, so a message that has finished is never
  // actively streaming regardless of the last poll — derived here rather than reset from
  // the effect when streaming stops.
  const isActivelyStreaming = message.isStreaming && recentlyStreamed;

  useEffect(() => {
    if (message.isStreaming) {
      lastTextRef.current = { text: message.text, time: Date.now() };
    }
  }, [message.text, message.isStreaming]);

  useEffect(() => {
    if (!message.isStreaming) return;
    const interval = setInterval(() => {
      setRecentlyStreamed(Date.now() - lastTextRef.current.time <= 1500);
    }, 250);
    return () => clearInterval(interval);
  }, [message.isStreaming]);

  const completedText = useMemo(
    () => (isActivelyStreaming ? getCompleteBlocksText(message.text) : ""),
    [message.text, isActivelyStreaming],
  );

  // While streaming, cut at section starts so earlier sections keep stable
  // string identity and their memoized MarkdownBlocks skip re-parsing. Raw
  // <svg> needs no pre-pass: rehypeRaw + the sanitize schema's SVG allowlist
  // handle it inside the markdown pipeline.
  const sections = useMemo(
    () => (completedText ? splitAtSectionStarts(completedText) : []),
    [completedText],
  );

  return (
    <div className="min-w-0 pb-1 group/message-block">
      <div ref={bodyRef} className="text-sm leading-relaxed text-foreground">
        {message.isStreaming && isActivelyStreaming ? (
          <>
            {sections.map((section, i) => (
              <MarkdownBlock key={i} text={section} />
            ))}
            <TypingDots className="ml-1" />
          </>
        ) : (
          <MarkdownBlock text={message.text} />
        )}
      </div>
      {showActions && (!message.isStreaming || !isActivelyStreaming) && (
        <MessageActionBar copyText={message.text} sentAt={message.sentAt}>
          {createTaskFromText && (
            <Tooltip
              onOpenChange={(open) => {
                if (open) setHasSelection(selectionWithin(bodyRef.current) !== null);
              }}
            >
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Create task from message"
                    // Read at click time, not from state: the selection is browser-owned and
                    // changes with no event this component subscribes to.
                    onClick={() =>
                      createTaskFromText(selectionWithin(bodyRef.current) ?? message.text)
                    }
                    className="text-muted-foreground/60 hover:text-foreground"
                  />
                }
              >
                <ListPlus className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>
                {hasSelection ? "Create task from selection" : "Create task from response"}
              </TooltipContent>
            </Tooltip>
          )}
        </MessageActionBar>
      )}
    </div>
  );
}
