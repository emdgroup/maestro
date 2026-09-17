import { useContext, useState } from "react";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { CanvasEventContext } from "../CanvasRenderer";

type DateTimeVariant = "date" | "time" | "datetime-local";

interface Props {
  label?: string;
  variant?: DateTimeVariant;
  value?: string;
  disabled?: boolean;
  componentId?: string;
  [key: string]: unknown;
}

export function CanvasDateTimeInput({
  label,
  variant = "datetime-local",
  value,
  disabled = false,
  componentId,
}: Props) {
  const events = useContext(CanvasEventContext);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const live = events != null && componentId != null;

  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      {live ? (
        <Input
          type={variant}
          value={picked ?? value ?? ""}
          disabled={disabled}
          onChange={(e) => {
            setPicked(e.target.value);
            events.record(componentId, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") events.emit(componentId, "submit", picked ?? value ?? "");
          }}
        />
      ) : (
        <Input type={variant} defaultValue={value} disabled={disabled} readOnly />
      )}
    </div>
  );
}
