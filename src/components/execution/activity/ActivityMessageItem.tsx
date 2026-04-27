import { useState, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot } from "lucide-react";
import { getDiffHighlighter } from "@/lib/shiki-highlighter";
import type { MessageItem } from "./types";

interface ActivityMessageItemProps {
  message: MessageItem;
}

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDiffHighlighter().then((hl) => {
      if (cancelled) return;
      try {
        const engine = hl.getHighlighterEngine();
        const result = engine.codeToHtml(code, {
          lang: lang || "text",
          themes: { dark: "github-dark", light: "github-light" },
          cssVariablePrefix: "--shiki-",
          defaultColor: false,
        });
        if (!cancelled) setHtml(result);
      } catch {
        // fallback to plain
      }
    });
    return () => { cancelled = true; };
  }, [code, lang]);

  if (html) {
    return (
      <div
        className="text-xs my-2 rounded-md overflow-x-auto border border-border [&_pre]:p-3 [&_pre]:m-0 [&_code]:font-mono"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki-generated trusted HTML
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs">
      <code>{code}</code>
    </pre>
  );
}

export function ActivityMessageItem({ message }: ActivityMessageItemProps) {
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
          {message.isStreaming ? (
            <>
              <span className="whitespace-pre-wrap break-words">{message.text}</span>
              <span className="inline-block w-[7px] h-[14px] bg-foreground ml-0.5 animate-[blink_1s_step-end_infinite] align-text-bottom" />
            </>
          ) : (
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: ({ children, className }) => {
                  const match = /language-(\w+)/.exec(className ?? "");
                  const lang = match ? match[1] : "";
                  const isBlock = Boolean(className?.startsWith("language-"));
                  if (isBlock) {
                    return (
                      <HighlightedCode code={String(children).replace(/\n$/, "")} lang={lang} />
                    );
                  }
                  return (
                    <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{children}</code>
                  );
                },
                pre: ({ children }) => <>{children}</>,
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
                li: ({ children }) => <li className="mb-0.5">{children}</li>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                table: ({ children }) => (
                  <div className="overflow-x-auto my-2">
                    <table className="w-full border-collapse text-xs">{children}</table>
                  </div>
                ),
                thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
                th: ({ children }) => (
                  <th className="border border-border px-2.5 py-1.5 text-left font-semibold text-muted-foreground">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="border border-border px-2.5 py-1 text-foreground/80">{children}</td>
                ),
              }}
            >
              {message.text}
            </Markdown>
          )}
        </div>
      </div>
    </div>
  );
}
