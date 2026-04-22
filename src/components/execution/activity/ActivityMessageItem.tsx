import Markdown from "react-markdown";
import type { MessageItem } from "./types";

interface ActivityMessageItemProps {
  message: MessageItem;
}

export function ActivityMessageItem({ message }: ActivityMessageItemProps) {
  return (
    <div className="text-sm leading-relaxed text-foreground">
      {message.isStreaming ? (
        <>
          <span className="whitespace-pre-wrap break-words">{message.text}</span>
          <span className="inline-block w-2 h-4 bg-foreground ml-0.5 animate-pulse" />
        </>
      ) : (
        <Markdown
          components={{
            code: ({ children, className }) => {
              const isBlock = className?.startsWith("language-");
              return isBlock ? (
                <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs">
                  <code className={className}>{children}</code>
                </pre>
              ) : (
                <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{children}</code>
              );
            },
            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
            li: ({ children }) => <li className="mb-0.5">{children}</li>,
            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          }}
        >
          {message.text}
        </Markdown>
      )}
    </div>
  );
}
