import { useState, useEffect, useRef, useMemo } from "react";
import { Check, Copy } from "lucide-react";
import type { MessageItem } from "./types";
import { Button } from "@/ui/button";
import {
  MarkdownBlock,
  SvgBlock,
  getCompleteBlocksText,
  splitSvgBlocks,
  useCopyToClipboard,
} from "./MarkdownBlock";

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
  const { copied: messageCopied, copy: handleCopyMessage } = useCopyToClipboard(message.text);

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

  const segments = useMemo(() => {
    const textToRender = isActivelyStreaming ? completedText : message.text;
    if (!textToRender) return [];
    return splitSvgBlocks(textToRender);
  }, [message.text, isActivelyStreaming, completedText]);
  const hasSvg = segments.some((s) => s.type === "svg");

  const renderedSegments = segments.map((seg, i) =>
    seg.type === "svg" ? (
      <SvgBlock key={i} code={seg.content} />
    ) : (
      <MarkdownBlock key={i} text={seg.content} />
    ),
  );

  return (
    <div className="min-w-0 pb-1 group">
      <div className="text-sm leading-relaxed text-foreground">
        {message.isStreaming && isActivelyStreaming ? (
          <>
            {completedText ? (
              hasSvg ? (
                renderedSegments
              ) : (
                <MarkdownBlock text={completedText} />
              )
            ) : null}
            <TypingDots className="ml-1" />
          </>
        ) : hasSvg ? (
          renderedSegments
        ) : (
          <MarkdownBlock text={message.text} />
        )}
      </div>
      {(!message.isStreaming || !isActivelyStreaming) && (
        <Button
          variant="ghost"
          onClick={handleCopyMessage}
          className="sticky bottom-14.5 float-right -mt-5 p-1 h-auto rounded-md text-transparent group-hover:text-muted-foreground hover:!text-foreground transition-colors"
          aria-label={messageCopied ? "Copied" : "Copy response"}
        >
          {messageCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </Button>
      )}
    </div>
  );
}
