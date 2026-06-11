import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

type DateTimeVariant = "date" | "time" | "datetime-local";

interface Props {
  label?: string;
  variant?: DateTimeVariant;
  value?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export function CanvasDateTimeInput({
  label,
  variant = "datetime-local",
  value,
  disabled = false,
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      <Input type={variant} defaultValue={value} disabled={disabled} readOnly />
    </div>
  );
}
