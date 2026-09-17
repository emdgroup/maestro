import { useContext, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Label } from "@/ui/label";
import { CanvasEventContext } from "../CanvasRenderer";

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
  componentId?: string;
  [key: string]: unknown;
}

export function CanvasChoicePicker({
  label,
  options = [],
  value,
  placeholder = "Select...",
  disabled = false,
  componentId,
}: Props) {
  const events = useContext(CanvasEventContext);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const live = events != null && componentId != null;

  const items = (
    <>
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
    </>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      {live ? (
        <Select
          value={picked ?? value}
          disabled={disabled}
          onValueChange={(next) => {
            const selected = next as string;
            setPicked(selected);
            events.record(componentId, selected);
            events.emit(componentId, "change", selected);
          }}
        >
          {items}
        </Select>
      ) : (
        <Select defaultValue={value} disabled={disabled}>
          {items}
        </Select>
      )}
    </div>
  );
}
