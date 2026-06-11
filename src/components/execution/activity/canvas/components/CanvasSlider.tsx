import { Slider } from "@/ui/slider";
import { Label } from "@/ui/label";

interface Props {
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  disabled?: boolean;
  [key: string]: unknown;
}

export function CanvasSlider({
  label,
  min = 0,
  max = 100,
  step = 1,
  value,
  disabled = false,
}: Props) {
  return (
    <div className="flex flex-col gap-2">
      {label && <Label>{label}</Label>}
      <Slider
        min={min}
        max={max}
        step={step}
        defaultValue={value !== undefined ? [value] : [min]}
        disabled={disabled}
      />
    </div>
  );
}
