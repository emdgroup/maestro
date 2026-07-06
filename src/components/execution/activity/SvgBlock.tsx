import { useMemo } from "react";
import { ZoomableContent } from "@/ui/zoomable-content";
import { sanitizeSvg } from "./markdown-sanitize";

export function SvgBlock({ code }: { code: string }) {
  const sanitized = useMemo(() => {
    try {
      return sanitizeSvg(code);
    } catch {
      return "";
    }
  }, [code]);

  if (!sanitized) {
    return (
      <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs text-destructive">
        {code}
      </pre>
    );
  }
  return (
    <ZoomableContent
      className="my-2 overflow-x-auto"
      ariaLabel="SVG graphic"
      lightboxContent={
        // biome-ignore lint/security/noDangerouslySetInnerHtml: user-provided SVG sanitized via DOM allowlist
        <div
          dangerouslySetInnerHTML={{ __html: sanitized }}
          className="[&_svg]:max-w-none [&_svg]:h-auto"
        />
      }
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: user-provided SVG sanitized via DOM allowlist */}
      <div dangerouslySetInnerHTML={{ __html: sanitized }} />
    </ZoomableContent>
  );
}
