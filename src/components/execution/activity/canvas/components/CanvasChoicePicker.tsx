import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Label } from "@/ui/label";

interface ChoiceOption {
  value: string;
  label: string;
}

interface Props {
  label?: string;
  options?: ChoiceOption[];
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export function CanvasChoicePicker({
  label,
  options = [],
  value,
  placeholder = "Select...",
  disabled = false,
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      <Select defaultValue={value} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
