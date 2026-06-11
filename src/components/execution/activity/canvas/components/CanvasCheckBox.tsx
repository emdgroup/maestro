import { Checkbox } from "@/ui/checkbox";
import { Label } from "@/ui/label";

interface Props {
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  [key: string]: unknown;
}

export function CanvasCheckBox({ label, checked = false, disabled = false }: Props) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox checked={checked} disabled={disabled} />
      {label && <Label>{label}</Label>}
    </div>
  );
}
