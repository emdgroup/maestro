import { useContext } from "react";
import { Button } from "@/ui/button";
import { CanvasEventContext } from "../CanvasRenderer";

type ButtonVariant = "default" | "outline" | "ghost" | "destructive" | "secondary";

interface Props {
  label?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  componentId?: string;
  [key: string]: unknown;
}

export function CanvasButton({
  label = "Button",
  variant = "default",
  disabled = false,
  componentId,
}: Props) {
  const events = useContext(CanvasEventContext);

  return (
    <Button
      variant={variant}
      disabled={disabled}
      type="button"
      onClick={componentId ? () => events?.emit(componentId, "click") : undefined}
    >
      {label}
    </Button>
  );
}
