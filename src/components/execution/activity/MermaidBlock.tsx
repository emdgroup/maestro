import { useState, useEffect, useId } from "react";
import { ZoomableContent } from "@/ui/zoomable-content";
import { useTheme } from "@/providers/ThemeProvider";
import { toast } from "sonner";

export function MermaidBlock({ code }: { code: string }) {
  const id = useId();
  const elId = `mermaid-${id.replace(/:/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const { theme, systemTheme } = useTheme();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(false);
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
            if (!cancelled) setSvg(rendered);
          })
          .catch((err: unknown) => {
            if (!cancelled) {
              setError(true);
              toast.error("Mermaid diagram syntax error", {
                id: elId,
                description: err instanceof Error ? err.message : "Failed to render diagram",
              });
            }
          });
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          toast.error("Failed to load mermaid renderer");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, elId, isDark]);

  if (error) {
    return (
      <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs text-destructive">
        {code}
      </pre>
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
