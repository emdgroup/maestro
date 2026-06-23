import { GitBranch } from "lucide-react";
import { BranchPicker } from "./BranchPicker";

interface BranchSectionProps {
  value: string;
  onChange?: (branch: string) => void;
  error?: string;
}

export function BranchSection({ value, onChange, error }: BranchSectionProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">
        FROM BRANCH
      </span>
      {onChange ? (
        <>
          <BranchPicker value={value} onChange={onChange} error={!!error} />
          {error && <span className="text-destructive text-xs">{error}</span>}
        </>
      ) : value ? (
        <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 h-7 text-xs text-muted-foreground font-mono cursor-default w-fit">
          <GitBranch className="size-3 shrink-0" />
          {value}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}
