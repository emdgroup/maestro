import { cn } from "@/lib/utils.ts";

type TextVariant = "heading" | "subheading" | "body" | "caption" | "code" | "label";

interface Props {
  text?: string;
  variant?: TextVariant;
  muted?: boolean;
  className?: string;
  [key: string]: unknown;
}

const variantClasses: Record<TextVariant, string> = {
  heading: "text-lg font-semibold",
  subheading: "text-base font-medium",
  body: "text-sm",
  caption: "text-xs text-muted-foreground",
  code: "text-xs font-mono bg-muted px-1.5 py-0.5 rounded",
  label: "text-xs font-medium uppercase tracking-wide text-muted-foreground",
};

export function CanvasText({ text, variant = "body", muted = false, className }: Props) {
  if (!text) return null;
  return (
    <span
      className={cn(
        variantClasses[variant] ?? variantClasses.body,
        muted && "text-muted-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}
