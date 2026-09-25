import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";

/** An agent's brand mark, else the icon its registry entry carries, else a generic robot. */
export function AgentIcon({
  agent,
  className,
}: {
  agent: { id: string; icon?: string | null };
  className?: string;
}) {
  if (hasBrandIcon(agent.id))
    return <BrandIcon slug={agent.id} className={cn("size-3 shrink-0", className)} />;
  if (agent.icon)
    return (
      <img
        src={agent.icon}
        className={cn("size-3 shrink-0 dark:[filter:invert(1)]", className)}
        alt=""
      />
    );
  return <Bot className={cn("size-3 shrink-0 text-muted-foreground", className)} />;
}
