import { Folder, Terminal, Container, ChevronRight } from "lucide-react";
import { Button } from "@/ui/button";
import type { Connection } from "@/contexts/ConnectionContext";

export function ConnectionItem({
  connection,
  onConnect,
  loading,
}: {
  connection: Connection;
  onConnect: () => void;
  loading: boolean;
}) {
  const icon =
    connection.type === "wsl" ? (
      <Terminal className="w-4 h-4 mt-0.5 shrink-0" />
    ) : connection.type === "docker" ? (
      <Container className="w-4 h-4 mt-0.5 shrink-0" />
    ) : (
      <Folder className="w-4 h-4 mt-0.5 shrink-0" />
    );

  return (
    <li className="relative">
      <Button
        onClick={onConnect}
        disabled={loading}
        variant="outline"
        className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-10 hover:bg-background hover:border-accent hover:text-accent dark:hover:border-accent dark:hover:text-accent dark:bg-background! shadow-md"
      >
        <div className="flex items-start gap-2 w-full">
          {icon}
          <div className="flex flex-col items-start gap-1 flex-1 min-w-0">
            <span className="font-semibold">{connection.displayName}</span>
            {connection.subtitle && (
              <span className="text-xs text-muted-foreground truncate w-full">
                {connection.subtitle}
              </span>
            )}
            {connection.metadata && (
              <span className="text-xs text-muted-foreground">{connection.metadata}</span>
            )}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      </Button>
    </li>
  );
}
