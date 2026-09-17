import { useContext, useState } from "react";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { CanvasEventContext } from "../CanvasRenderer";

interface Props {
  label?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  componentId?: string;
  [key: string]: unknown;
}

export function CanvasTextField({
  label,
  placeholder,
  value,
  disabled = false,
  componentId,
}: Props) {
  const events = useContext(CanvasEventContext);
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const live = events != null && componentId != null;

  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      {live ? (
        <Input
          placeholder={placeholder}
          value={typed ?? value ?? ""}
          disabled={disabled}
          onChange={(e) => {
            setTyped(e.target.value);
            events.record(componentId, e.target.value);
          }}
          // Typing records but does not resolve: a form's other fields would be lost the moment
          // the first character landed. Enter is the explicit "I am done" the agent waits on, and
          // every recorded field rides along on the event.
          onKeyDown={(e) => {
            if (e.key === "Enter") events.emit(componentId, "submit", typed ?? value ?? "");
          }}
        />
      ) : (
        <Input placeholder={placeholder} defaultValue={value} disabled={disabled} readOnly />
      )}
    </div>
  );
}
