import { Brain } from "lucide-react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  BaseDropdownSelector,
  ITEM_CLASS,
  ITEM_TEXT_CLASS,
  DESC_CLASS,
} from "./BaseDropdownSelector";
import type { SelectorProps } from "./BaseDropdownSelector";

function extractCost(description?: string): string | null {
  if (!description) return null;
  const match = description.match(/\$[\d.]+\/\$[\d.]+/);
  return match ? match[0] : null;
}

function stripCost(description?: string): string {
  if (!description) return "";
  return description
    .replace(/ · \$[\d.]+\/\$[\d.]+ per Mtok\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function ModelSelector({ option, value, onChange, disabled }: SelectorProps) {
  const currentOption = option.options.find((o) => o.value === value);
  const triggerCost = extractCost(currentOption?.description ?? option.description);

  return (
    <BaseDropdownSelector
      option={option}
      value={value}
      onChange={onChange}
      disabled={disabled}
      contentClassName="w-64"
      triggerContent={
        <>
          <Brain className="size-3 shrink-0" />
          <span>{currentOption?.name ?? value}</span>
          {triggerCost && (
            <span className="text-[10px] text-muted-foreground/50">{triggerCost}</span>
          )}
        </>
      }
      renderItem={(opt) => {
        const cost = extractCost(opt.description);
        const desc = stripCost(opt.description);
        return (
          <SelectPrimitive.Item key={opt.value} value={opt.value} className={ITEM_CLASS}>
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <SelectPrimitive.ItemText className={ITEM_TEXT_CLASS}>
                  {opt.name}
                </SelectPrimitive.ItemText>
                {cost && (
                  <span className="ml-auto text-[10px] text-muted-foreground/60 group-data-highlighted:text-accent-foreground/60 shrink-0">
                    {cost}
                  </span>
                )}
              </div>
              {desc && <span className={DESC_CLASS}>{desc}</span>}
            </div>
          </SelectPrimitive.Item>
        );
      }}
    />
  );
}
