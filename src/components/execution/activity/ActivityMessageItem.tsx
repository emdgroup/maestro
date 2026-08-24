import { useState, useEffect, useRef, useMemo } from "react";
import type { MessageItem } from "./types";
import { MarkdownBlock, getCompleteBlocksText } from "./MarkdownBlock";
import { MessageActionBar } from "./MessageActionBar";
import { splitAtSectionStarts } from "./markdown-stream-utils";

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

export function ActivityMessageItem({ message, showActions }: ActivityMessageItemProps) {
  const lastTextRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const [recentlyStreamed, setRecentlyStreamed] = useState(false);
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
      <div className="text-sm leading-relaxed text-foreground">
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
        <MessageActionBar copyText={message.text} sentAt={message.sentAt} />
      )}
    </div>
  );
}
