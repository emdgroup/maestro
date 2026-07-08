import { Shield, ShieldOff } from "lucide-react";
import type { PermissionResponseItem } from "./types";
import { Marker, MarkerIcon, MarkerContent } from "@/ui/marker";

interface PermissionResponseCardProps {
  item: PermissionResponseItem;
}

export function PermissionResponseCard({ item }: PermissionResponseCardProps) {
  const colorClass = item.isRejection ? "text-destructive" : "text-muted-foreground";
  const Icon = item.isRejection ? ShieldOff : Shield;

  return (
    <Marker className="gap-1.5 py-0.5">
      <MarkerIcon>
        <Icon className={`size-3 ${colorClass}`} />
      </MarkerIcon>
      <MarkerContent className={`text-[11px] font-medium ${colorClass}`}>
        {item.optionName}
      </MarkerContent>
    </Marker>
  );
}
