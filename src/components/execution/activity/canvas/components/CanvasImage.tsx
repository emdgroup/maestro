import { ZoomableContent } from "@/ui/zoomable-content";
import { cn } from "@/lib/ui-utils";

interface Props {
  src?: string;
  alt?: string;
  width?: string | number;
  height?: string | number;
  className?: string;
  [key: string]: unknown;
}

export function CanvasImage({ src, alt = "", width, height, className }: Props) {
  if (!src) return null;
  return (
    <ZoomableContent>
      <img
        src={src}
        alt={alt}
        className={cn("rounded max-w-full object-contain", className)}
        style={{ width: width ?? undefined, height: height ?? undefined }}
      />
    </ZoomableContent>
  );
}
