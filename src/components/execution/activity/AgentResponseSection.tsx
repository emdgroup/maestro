import type { ReactNode } from "react";
import { BotMessageSquare } from "lucide-react";

interface AgentResponseSectionProps {
  showConnector: boolean;
  children: ReactNode;
}

export function AgentResponseSection({ showConnector, children }: AgentResponseSectionProps) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="flex flex-col items-center flex-shrink-0 w-7 self-stretch">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent/70 to-accent/35 flex items-center justify-center flex-shrink-0">
          <BotMessageSquare className="w-4 h-4 text-white" />
        </div>
        {showConnector && (
          <div className="w-[1.5px] flex-1 bg-gradient-to-b from-accent/30 via-accent/30 to-transparent [--tw-gradient-via-position:90%] mt-1" />
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-3">{children}</div>
    </div>
  );
}
