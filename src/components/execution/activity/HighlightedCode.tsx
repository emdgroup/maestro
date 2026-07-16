import { useState, useEffect, useRef, useCallback, memo } from "react";
import { Copy, Check } from "lucide-react";
import { getDiffHighlighter } from "@/lib/shiki-highlighter";
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

export const HighlightedCode = memo(function HighlightedCode({
  code,
  lang,
  stripContainerStyle = false,
}: {
  code: string;
  lang: string;
  stripContainerStyle?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const { theme, systemTheme } = useTheme();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";

  useEffect(() => {
    let cancelled = false;
    getDiffHighlighter().then((hl) => {
      if (cancelled) return;
      try {
        const engine = hl.getHighlighterEngine();
        const result = engine.codeToHtml(code, {
          lang: lang || "text",
          theme: isDark ? "github-dark" : "github-light",
        });
        const stripped = stripContainerStyle
          ? result.replace(/<pre([^>]*?) style="[^"]*"/, "<pre$1")
          : result;
        if (!cancelled) setHtml(stripped);
      } catch {
        // fallback to plain
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, isDark, stripContainerStyle]);

  if (html) {
    return (
      <div
        className="text-xs overflow-x-auto [&_pre]:p-3 [&_pre]:m-0 [&_pre]:rounded-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="bg-background p-3 overflow-x-auto text-xs">
      <code>{code}</code>
    </pre>
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
    <div className="relative group/code my-2 rounded-md border border-border overflow-hidden">
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b border-border"
        style={{ background: "color-mix(in oklch, var(--foreground) 15%, var(--muted))" }}
      >
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">
          {lang || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="opacity-0 group-hover/code:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-foreground"
          aria-label={copied ? "Copied" : "Copy"}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
      <HighlightedCode code={code} lang={lang} stripContainerStyle={stripContainerStyle} />
    </div>
  );
});
