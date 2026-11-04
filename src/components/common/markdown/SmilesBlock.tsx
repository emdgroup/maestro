import { useState, useEffect, useRef } from "react";
import { ZoomableContent } from "@/ui/zoomable-content";
import { useTheme } from "@/providers/ThemeProvider";
import SmilesDrawer from "smiles-drawer";

export function SmilesBlock({ code }: { code: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { theme, systemTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [svgHtml, setSvgHtml] = useState("");
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    setError(null);

    SmilesDrawer.parse(
      code.trim(),
      (tree) => {
        const drawer = new SmilesDrawer.SvgDrawer({ width: 400, height: 300, padding: 20 });
        drawer.draw(tree, svgEl, resolvedTheme);
        setSvgHtml(svgEl.outerHTML);
      },
      (err) => {
        setError(String(err));
      },
    );
  }, [code, resolvedTheme]);

  if (error) {
    return (
      <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs text-destructive">
        Invalid SMILES: {code}
      </pre>
    );
  }

  return (
    <ZoomableContent
      className="my-2 flex justify-start"
      ariaLabel="Molecular structure"
      lightboxContent={
        svgHtml ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: SmilesDrawer-generated SVG
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            className="[&_svg]:max-w-none [&_svg]:h-auto"
          />
        ) : undefined
      }
    >
      <svg ref={svgRef} width={400} height={300} />
    </ZoomableContent>
  );
}
