import { useState, useEffect, useRef, useMemo } from "react";
import type { MessageItem } from "./types";
import { MarkdownBlock, getCompleteBlocksText } from "./MarkdownBlock";
import { MessageActionBar } from "./MessageActionBar";
import { splitAtSectionStarts } from "./markdown-stream-utils";

export { getCompleteBlocksText } from "./MarkdownBlock";

interface ActivityMessageItemProps {
  message: MessageItem;
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

export function ActivityMessageItem({ message }: ActivityMessageItemProps) {
  const lastTextRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const [isActivelyStreaming, setIsActivelyStreaming] = useState(false);

  useEffect(() => {
    if (message.isStreaming) {
      lastTextRef.current = { text: message.text, time: Date.now() };
    }
  }, [message.text, message.isStreaming]);

  useEffect(() => {
    if (!message.isStreaming) {
      setIsActivelyStreaming(false);
      return;
    }
    const interval = setInterval(() => {
      const stale = Date.now() - lastTextRef.current.time > 1500;
      setIsActivelyStreaming(!stale);
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
      {(!message.isStreaming || !isActivelyStreaming) && (
        <MessageActionBar copyText={message.text} sentAt={message.sentAt} />
      )}
    </div>
  );
}
