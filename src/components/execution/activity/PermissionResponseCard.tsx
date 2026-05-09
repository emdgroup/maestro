import { Shield, ShieldOff } from "lucide-react";
import type { PermissionResponseItem } from "./types";

interface PermissionResponseCardProps {
  item: PermissionResponseItem;
}

export function PermissionResponseCard({ item }: PermissionResponseCardProps) {
  const colorClass = item.isRejection ? "text-destructive" : "text-muted-foreground";
  const Icon = item.isRejection ? ShieldOff : Shield;

  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <Icon className={`w-3 h-3 shrink-0 ${colorClass}`} />
      <span className={`text-[11px] font-medium ${colorClass}`}>{item.optionName}</span>
    </div>
  );
}
