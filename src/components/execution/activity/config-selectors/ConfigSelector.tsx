import type { ConfigOption } from "../types";
import { ModelSelector } from "./ModelSelector";
import { ModeSelector } from "./ModeSelector";
import { EffortSelector } from "./EffortSelector";
import { GenericSelector } from "./GenericSelector";

interface ConfigSelectorProps {
  option: ConfigOption;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ConfigSelector({ option, value, onChange, disabled }: ConfigSelectorProps) {
  switch (option.category) {
    case "model":
      return <ModelSelector option={option} value={value} onChange={onChange} disabled={disabled} />;
    case "mode":
      return <ModeSelector option={option} value={value} onChange={onChange} disabled={disabled} />;
    case "effort":
      return <EffortSelector option={option} value={value} onChange={onChange} disabled={disabled} />;
    default:
      return <GenericSelector option={option} value={value} onChange={onChange} disabled={disabled} />;
  }
}
