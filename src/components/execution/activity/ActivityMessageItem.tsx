import { useState, useEffect, useRef, useMemo } from "react";
import { Bot, Check, Copy } from "lucide-react";
import type { MessageItem } from "./types";
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

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[2px] ml-1 align-middle" aria-label="typing">
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

  return (
    <div className="flex items-start gap-2.5 group">
      <div className="flex flex-col items-center flex-shrink-0 w-7 self-stretch">
        <div className="w-7 h-7 rounded-md bg-accent/20 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Bot className="w-4 h-4 text-accent-foreground/70" />
        </div>
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-1">
        <div className="text-sm leading-relaxed text-foreground">
          {message.isStreaming && isActivelyStreaming ? (
            <>
              {completedText ? (
                hasSvg ? (
                  segments.map((seg, i) =>
                    seg.type === "svg" ? (
                      <SvgBlock key={i} code={seg.content} />
                    ) : (
                      <MarkdownBlock key={i} text={seg.content} />
                    ),
                  )
                ) : (
                  <MarkdownBlock text={completedText} />
                )
              ) : null}
              <TypingDots />
            </>
          ) : hasSvg ? (
            segments.map((seg, i) =>
              seg.type === "svg" ? (
                <SvgBlock key={i} code={seg.content} />
              ) : (
                <MarkdownBlock key={i} text={seg.content} />
              ),
            )
          ) : (
            <MarkdownBlock text={message.text} />
          )}
        </div>
        {(!message.isStreaming || !isActivelyStreaming) && (
          <div className="flex justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={handleCopyMessage}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground"
              aria-label={messageCopied ? "Copied" : "Copy response"}
            >
              {messageCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
