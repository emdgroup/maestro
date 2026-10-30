import { useState, useEffect, useRef, useCallback, memo } from "react";
import { Copy, Check } from "lucide-react";
import { highlightToHtml } from "@/lib/diff-highlighter";
import { cn } from "@/lib/utils";
import { useTheme } from "@/providers/ThemeProvider";

export function useCopyToClipboard(text: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [text]);
  return { copied, copy };
}

/**
 * The icon for a copy control: Copy, then a Check drawing itself in while `copied` holds. Both are
 * always mounted so the swap animates each way; `.copy-state` in `index.css` drives it, and
 * `className` sizes the box.
 */
export function CopyStateIcon({ copied, className }: { copied: boolean; className?: string }) {
  return (
    <span data-copied={copied} className={cn("copy-state grid shrink-0", className)}>
      <Copy className="size-full" />
      <Check className="size-full text-success" />
    </span>
  );
}

export const HighlightedCode = memo(function HighlightedCode({
  code,
  lang,
  stripContainerStyle = false,
  className,
}: {
  code: string;
  lang: string;
  stripContainerStyle?: boolean;
  /** Merged over the defaults — pass `[&_pre]:…` to restyle the highlighter's own element. */
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const { theme, systemTheme } = useTheme();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";

  useEffect(() => {
    let cancelled = false;
    highlightToHtml(code, lang || "text", isDark).then(
      (result) => {
        const stripped = stripContainerStyle
          ? result.replace(/<pre([^>]*?) style="[^"]*"/, "<pre$1")
          : result;
        if (!cancelled) setHtml(stripped);
      },
      () => {
        // fallback to plain
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, lang, isDark, stripContainerStyle]);

  if (html) {
    return (
      <div
        className={cn(
          "text-xs [&_pre]:overflow-x-auto [&_pre]:p-3 [&_pre]:m-0 [&_pre]:rounded-none",
          className,
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  // The highlighter loads async; until it resolves this must occupy the same box, or an
  // expanding row visibly reflows once the grammar lands.
  return (
    <div className={cn("text-xs [&_pre]:overflow-x-auto [&_pre]:m-0 [&_pre]:p-3", className)}>
      <pre className="bg-background">
        <code>{code}</code>
      </pre>
    </div>
  );
});

export const CodeBlockWrapper = memo(function CodeBlockWrapper({
  code,
  lang,
  stripContainerStyle,
}: {
  code: string;
  lang: string;
  stripContainerStyle?: boolean;
}) {
  const { copied, copy: handleCopy } = useCopyToClipboard(code);

  return (
    <div className="glass-tile relative group/code my-3 rounded-[14px] bg-foreground/12! p-1 shadow-[0_6px_18px_-8px_rgb(0_0_0/0.35)]! dark:shadow-[0_8px_20px_-8px_rgb(0_0_0/0.8)]!">
      <div className="flex items-center justify-between px-2 pt-0.5 pb-1">
        <span className="text-[10px] font-mono text-foreground/70 uppercase tracking-wide">
          {lang || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="opacity-0 group-hover/code:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-foreground"
          aria-label={copied ? "Copied" : "Copy"}
        >
          <CopyStateIcon copied={copied} className="size-3" />
        </button>
      </div>
      <HighlightedCode
        code={code}
        lang={lang}
        stripContainerStyle={stripContainerStyle}
        className="rounded-[10px] overflow-hidden"
      />
    </div>
  );
});
