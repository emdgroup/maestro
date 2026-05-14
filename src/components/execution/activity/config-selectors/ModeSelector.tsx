import { Shield, ShieldCheck, ShieldEllipsis, ShieldAlert, ShieldOff, Eye } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { BaseDropdownSelector, ITEM_CLASS, ITEM_TEXT_CLASS, DESC_CLASS } from "./BaseDropdownSelector";
import type { SelectorProps } from "./BaseDropdownSelector";

const MODE_ICONS: Record<string, LucideIcon> = {
  plan: Eye,
  default: Shield,
  auto: ShieldCheck,
  acceptEdits: ShieldEllipsis,
  dontAsk: ShieldAlert,
  bypassPermissions: ShieldOff,
};

function modeIcon(value: string): LucideIcon {
  return MODE_ICONS[value] ?? Shield;
}

export function ModeSelector({ option, value, onChange, disabled }: SelectorProps) {
  const currentOption = option.options.find((o) => o.value === value);
  const TriggerIcon = modeIcon(value);

  return (
    <BaseDropdownSelector
      option={option}
      value={value}
      onChange={onChange}
      disabled={disabled}
      contentClassName="w-64"
      triggerContent={
        <>
          <TriggerIcon className="size-3 shrink-0" />
          <span>{currentOption?.name ?? value}</span>
        </>
      }
      renderItem={(opt) => {
        const ItemIcon = modeIcon(opt.value);
        return (
          <SelectPrimitive.Item key={opt.value} value={opt.value} className={ITEM_CLASS}>
            <ItemIcon className="size-4 shrink-0 mt-0.5 group-data-selected:text-accent group-data-highlighted:!text-accent-foreground" />
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
              <SelectPrimitive.ItemText className={ITEM_TEXT_CLASS}>
                {opt.name}
              </SelectPrimitive.ItemText>
              {opt.description && <span className={DESC_CLASS}>{opt.description}</span>}
            </div>
          </SelectPrimitive.Item>
        );
      }}
    />
  );
}
