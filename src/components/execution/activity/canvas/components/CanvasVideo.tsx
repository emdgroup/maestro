import { cn } from "@/lib/ui-utils";

interface Props {
  src?: string;
  poster?: string;
  className?: string;
  [key: string]: unknown;
}

export function CanvasVideo({ src, poster, className }: Props) {
  if (!src) return null;
  return (
    <video
      src={src}
      poster={poster}
      controls
      className={cn("rounded max-w-full", className)}
    />
  );
}
