import { useContext, useState } from "react";
import { Checkbox } from "@/ui/checkbox";
import { Label } from "@/ui/label";
import { CanvasEventContext } from "../CanvasRenderer";

interface Props {
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  componentId?: string;
  [key: string]: unknown;
}

export function CanvasCheckBox({ label, checked = false, disabled = false, componentId }: Props) {
  const events = useContext(CanvasEventContext);
  // `undefined` until the user touches it, so the box keeps following the agent's own value
  // until then — including across a `canvas_update` that revises it.
  const [touched, setTouched] = useState<boolean | undefined>(undefined);
  const live = events != null && componentId != null;

  return (
    <div className="flex items-center gap-2">
      <Checkbox
        checked={touched ?? checked}
        disabled={disabled}
        onCheckedChange={
          live
            ? (next) => {
                setTouched(next);
                events.record(componentId, next);
                events.emit(componentId, "change", next);
              }
            : undefined
        }
      />
      {label && <Label>{label}</Label>}
    </div>
  );
}
