import { Button } from "@/ui/button";

type ButtonVariant = "default" | "outline" | "ghost" | "destructive" | "secondary";

interface Props {
  label?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  [key: string]: unknown;
}

export function CanvasButton({ label = "Button", variant = "default", disabled = false }: Props) {
  return (
    <Button variant={variant} disabled={disabled} type="button">
      {label}
    </Button>
  );
}
