import { useContext } from "react";
import { Slider } from "@/ui/slider";
import { Label } from "@/ui/label";
import { CanvasEventContext } from "../CanvasRenderer";

interface Props {
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  disabled?: boolean;
  componentId?: string;
  [key: string]: unknown;
}

export function CanvasSlider({
  label,
  min = 0,
  max = 100,
  step = 1,
  value,
  disabled = false,
  componentId,
}: Props) {
  const events = useContext(CanvasEventContext);
  const live = events != null && componentId != null;

  return (
    <div className="flex flex-col gap-2">
      {label && <Label>{label}</Label>}
      <Slider
        min={min}
        max={max}
        step={step}
        defaultValue={value !== undefined ? [value] : [min]}
        disabled={disabled}
        // On commit rather than on every change: dragging a slider would otherwise resolve the
        // agent's wait on the first pixel of the gesture.
        onValueCommitted={
          live
            ? (next) => {
                const committed = Array.isArray(next) ? next[0] : next;
                events.record(componentId, committed);
                events.emit(componentId, "change", committed);
              }
            : undefined
        }
      />
    </div>
  );
}
