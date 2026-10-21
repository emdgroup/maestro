import { useState, useEffect, useId } from "react";
import { ZoomableContent } from "@/ui/zoomable-content";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CodeBlockWrapper } from "./HighlightedCode";
import { useTheme } from "@/providers/ThemeProvider";

export function MermaidBlock({ code }: { code: string }) {
  const id = useId();
  const elId = `mermaid-${id.replace(/:/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme, systemTheme } = useTheme();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";

  // Drop the previous diagram as soon as the source or theme changes, so the stale one is
  // not left on screen while the new render runs. Adjusted during render rather than from
  // the effect below, which owns only the async import and render. The separator must be
  // the escape sequence, not a literal NUL byte: one in the source makes git treat the
  // whole file as binary and show no diff hunks at all.
  const renderKey = `${isDark ? "dark" : "light"}\0${code}`;
  const [renderedKey, setRenderedKey] = useState(renderKey);
  if (renderedKey !== renderKey) {
    setRenderedKey(renderKey);
    setSvg(null);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    import("mermaid")
      .then((m) => {
        if (cancelled) return;
        m.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "default",
        });
        m.default
          .render(elId, code)
          .then(({ svg: rendered }) => {
            if (!cancelled) {
              if (rendered.includes('aria-roledescription="error"')) {
                setError("Diagram could not be rendered");
              } else {
                setSvg(rendered);
              }
            }
          })
          .catch((err: unknown) => {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : "Diagram could not be rendered");
            }
          });
      })
      .catch(() => {
        if (!cancelled) setError("Mermaid renderer failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [code, elId, isDark]);

  // A malformed diagram is the agent's output, not an app failure: show the source as a normal
  // code block with a quiet note. It used to raise a toast, which re-fired on every remount —
  // so switching back to a session replayed the error long after it stopped being news.
  if (error) {
    return (
      <div className="my-2">
        <CodeBlockWrapper code={code} lang="mermaid" />
        <Tooltip>
          <TooltipTrigger render={<p className="text-[11px] text-muted-foreground mt-1 px-1" />}>
            Not shown as a diagram — {error.split("\n")[0]}
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-wrap break-words">{error}</TooltipContent>
        </Tooltip>
      </div>
    );
  }
  if (!svg) {
    return <div className="h-24 bg-muted/50 rounded-md my-2 animate-pulse" />;
  }
  return (
    <ZoomableContent
      className="my-2 overflow-x-auto"
      ariaLabel="Mermaid diagram"
      lightboxContent={
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-mode SVG
        <div
          dangerouslySetInnerHTML={{ __html: svg }}
          className="[&_svg]:max-w-none [&_svg]:h-auto"
        />
      }
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-mode SVG */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </ZoomableContent>
  );
}
