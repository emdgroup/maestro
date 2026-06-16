import { Select as SelectPrimitive } from "@base-ui/react/select";
import { SelectContent } from "@/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/ui-utils";
import type { ConfigOption, ConfigOptionValue } from "../types";

export interface SelectorProps {
  option: ConfigOption;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export const TRIGGER_CLASS =
  "inline-flex items-center gap-1 py-0.5 pl-1.5 pr-1.5 text-[11px] rounded border border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer focus:outline-none select-none";

export const ITEM_CLASS =
  "group relative flex w-full cursor-default items-start gap-2 rounded-sm py-2 pl-2 pr-2 outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50";

export const ITEM_TEXT_CLASS =
  "text-xs font-medium leading-none group-data-selected:text-accent group-data-highlighted:!text-accent-foreground";

export const DESC_CLASS =
  "text-[11px] text-muted-foreground leading-snug group-data-highlighted:text-accent-foreground/70";

const GLASS_CONTENT_CLASS =
  "backdrop-blur-[4px] bg-muted/60 border border-border/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] ring-0";

interface BaseDropdownSelectorProps {
  option: ConfigOption;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  triggerContent: React.ReactNode;
  contentClassName?: string;
  renderItem: (opt: ConfigOptionValue, index: number) => React.ReactNode;
}

export function BaseDropdownSelector({
  option,
  value,
  onChange,
  disabled,
  triggerContent,
  contentClassName,
  renderItem,
}: BaseDropdownSelectorProps) {
  return (
    <TooltipProvider delay={700}>
      <SelectPrimitive.Root
        name={option.name}
        value={value}
        onValueChange={(v) => v !== null && onChange(v)}
        disabled={disabled}
      >
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex items-center" />}>
            <SelectPrimitive.Trigger className={TRIGGER_CLASS}>
              {triggerContent}
            </SelectPrimitive.Trigger>
          </TooltipTrigger>
          {option.description && (
            <TooltipContent side="top" sideOffset={6}>
              {option.description}
            </TooltipContent>
          )}
        </Tooltip>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          sideOffset={4}
          className={cn(
            GLASS_CONTENT_CLASS,
            "p-1 max-h-128 overflow-y-auto custom-scrollbar",
            contentClassName,
          )}
        >
          {option.options.map((opt, i) => renderItem(opt, i))}
        </SelectContent>
      </SelectPrimitive.Root>
    </TooltipProvider>
  );
}
