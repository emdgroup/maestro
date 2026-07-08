import type { ReactNode } from "react";
import { BotMessageSquare } from "lucide-react";
import { Message, MessageContent } from "@/ui/message";

interface AgentResponseSectionProps {
  showConnector: boolean;
  children: ReactNode;
}

export function AgentResponseSection({ showConnector, children }: AgentResponseSectionProps) {
  return (
    <Message className="gap-2.5 items-start">
      <div className="flex flex-col items-center flex-shrink-0 w-7 self-stretch">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent/70 to-accent/35 flex items-center justify-center flex-shrink-0">
          <BotMessageSquare className="w-4 h-4 text-white" />
        </div>
        {showConnector && (
          <div className="w-[1.5px] flex-1 bg-gradient-to-b from-accent/30 via-accent/30 to-transparent [--tw-gradient-via-position:90%] mt-1" />
        )}
      </div>
      <MessageContent className="flex-1 gap-3">{children}</MessageContent>
    </Message>
  );
}
