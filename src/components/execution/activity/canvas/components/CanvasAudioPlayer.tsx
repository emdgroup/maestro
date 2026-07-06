import { cn } from "@/lib/utils.ts";

interface Props {
  src?: string;
  className?: string;
  [key: string]: unknown;
}

export function CanvasAudioPlayer({ src, className }: Props) {
  if (!src) return null;
  return <audio src={src} controls className={cn("w-full", className)} />;
}
