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
        // An svg with only a viewBox sizes to its container, and the lightbox's centring wrapper
        // shrinks to its content, so without a width it collapses to 0x0. Fit-to-view rescales it.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: user-provided SVG sanitized via DOM allowlist
        <div
          dangerouslySetInnerHTML={{ __html: sanitized }}
          className="[&_svg]:max-w-none [&_svg]:h-auto [&_svg:not([width])]:w-[80vw]"
        />
      }
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: user-provided SVG sanitized via DOM allowlist */}
      <div dangerouslySetInnerHTML={{ __html: sanitized }} />
    </ZoomableContent>
  );
}
