import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  BaseDropdownSelector,
  ITEM_CLASS,
  ITEM_TEXT_CLASS,
  DESC_CLASS,
} from "./BaseDropdownSelector";
import type { SelectorProps } from "./BaseDropdownSelector";

export function GenericSelector({ option, value, onChange, disabled }: SelectorProps) {
  const currentOption = option.options.find((o) => o.value === value);

  return (
    <BaseDropdownSelector
      option={option}
      value={value}
      onChange={onChange}
      disabled={disabled}
      contentClassName="w-48"
      triggerContent={<span>{currentOption?.name ?? value}</span>}
      renderItem={(opt) => (
        <SelectPrimitive.Item key={opt.value} value={opt.value} className={ITEM_CLASS}>
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <SelectPrimitive.ItemText className={ITEM_TEXT_CLASS}>
              {opt.name}
            </SelectPrimitive.ItemText>
            {opt.description && <span className={DESC_CLASS}>{opt.description}</span>}
          </div>
        </SelectPrimitive.Item>
      )}
    />
  );
}
