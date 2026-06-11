import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

interface Props {
  label?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export function CanvasTextField({ label, placeholder, value, disabled = false }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      <Input placeholder={placeholder} defaultValue={value} disabled={disabled} readOnly />
    </div>
  );
}
