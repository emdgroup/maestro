import type { ConfigOption } from "../types";
import { ModelSelector } from "./ModelSelector";
import { ModeSelector } from "./ModeSelector";
import { EffortSelector } from "./EffortSelector";
import { GenericSelector } from "./GenericSelector";
import { AgentSelector } from "./AgentSelector";

interface ConfigSelectorProps {
  option: ConfigOption;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ConfigSelector({ option, value, onChange, disabled }: ConfigSelectorProps) {
  if (option.id === "agent") {
    return <AgentSelector option={option} value={value} onChange={onChange} disabled={disabled} />;
  }
  switch (option.category) {
    case "model":
      return (
        <ModelSelector option={option} value={value} onChange={onChange} disabled={disabled} />
      );
    case "mode":
      return <ModeSelector option={option} value={value} onChange={onChange} disabled={disabled} />;
    case "effort":
    case "thought_level":
      return (
        <EffortSelector option={option} value={value} onChange={onChange} disabled={disabled} />
      );
    default:
      return (
        <GenericSelector option={option} value={value} onChange={onChange} disabled={disabled} />
      );
  }
}
