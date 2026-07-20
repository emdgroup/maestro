import React, { useState, useEffect, Fragment } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Loader2, TerminalSquare } from "lucide-react";
import type { ConnectionKey } from "@/types/bindings";
import { commands } from "@/types/bindings";
import { useAgentAuthInfoQuery, useAcpAuthenticateMutation } from "@/services/acp-auth.service";
import { useNavigate } from "@/store/navigationStore";
import { useBoardActions } from "@/store/boardStore";

interface AgentAuthModalProps {
  agentId: string;
  agentName: string;
  connection: ConnectionKey;
  open: boolean;
  onAuthSuccess: () => void;
  onClose: () => void;
  // Optional: when provided, terminal-type auth methods open a side-panel tab instead of using the mutation.
  taskId?: number;
  sessionKey?: number | null;
  terminalState?: "idle" | "running" | "interrupted";
  onRetry?: () => void;
}

const URL_RE = /https?:\/\/\S+/g;

function linkifyLine(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const url = m[0];
    parts.push(
      <a
        key={m.index}
        href="#"
        className="text-primary underline"
        onClick={(e) => {
          e.preventDefault();
          void openUrl(url);
        }}
      >
        {url}
      </a>,
    );
    last = m.index + url.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : line;
}

export function AgentAuthModal({
  agentId,
  agentName,
  connection,
  open,
  onAuthSuccess,
  onClose,
  taskId,
  sessionKey,
  terminalState,
  onRetry,
}: AgentAuthModalProps) {
  const { data: authInfo } = useAgentAuthInfoQuery(agentId, connection);
  const authenticate = useAcpAuthenticateMutation();
  const navigate = useNavigate();
  const { setAuthTerminalRunning } = useBoardActions();
  const [authError, setAuthError] = useState<string | null>(null);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [isStartingTerminal, setIsStartingTerminal] = useState(false);

  useEffect(() => {
    if (!authenticate.isPending) return;
    setOutputLines([]);
    const connId = connectionKeyId(connection);
    let unlisten: (() => void) | undefined;
    listen<{ level: string; message: string }>(`acp://auth-output/${connId}`, (e) => {
      setOutputLines((prev) => [...prev, e.payload.message]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [authenticate.isPending, connection]);

  const authMethods = authInfo?.authMethods ?? [];

  async function handleSelect(methodId: string, methodType: string) {
    setAuthError(null);

    // Terminal methods with a task context open an interactive tab in the side panel.
    if (methodType === "terminal" && taskId != null && sessionKey != null) {
      setIsStartingTerminal(true);
      try {
        const result = await commands.acpStartAuthTerminal(
          agentId,
          methodId,
          connection,
          sessionKey,
        );
        if (result.status === "error") throw new Error(result.error);
        const terminalId = result.data;
        navigate({ agentId: String(taskId) });
        setAuthTerminalRunning(taskId, terminalId);
        onClose();
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsStartingTerminal(false);
      }
      return;
    }

    try {
      await authenticate.mutateAsync({ agentId, methodId, connection });
      onAuthSuccess();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  }

  function connectionKeyId(key: ConnectionKey): string {
    if (key.type === "local") return "local";
    if (key.type === "ssh") return `ssh-${key.id}`;
    if (key.type === "wsl") return `wsl-${key.id}`;
    return `docker-${key.id}`;
  }

  const isInProgress = authenticate.isPending || isStartingTerminal;

  // When a terminal PTY is running: show info message (the terminal tab is in the agents panel).
  if (terminalState === "running" && taskId != null) {
    return (
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Sign in to {agentName}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground">
            <TerminalSquare className="w-6 h-6" />
            <span className="text-center">
              Authentication terminal is open — complete the sign-in in the agent panel.
            </span>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // When the terminal tab was closed before auth completed: show retry/cancel.
  if (terminalState === "interrupted" && taskId != null) {
    return (
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Sign in to {agentName}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground">
            <span>Authentication was interrupted. Retry to open a new terminal tab.</span>
          </div>
          <DialogFooter className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                onRetry?.();
              }}
            >
              Retry
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent showCloseButton={!isInProgress}>
        <DialogHeader>
          <DialogTitle>Sign in to {agentName}</DialogTitle>
        </DialogHeader>

        {isInProgress ? (
          <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span>
              Authentication in progress — follow any prompts in your browser or terminal.
            </span>
            {outputLines.length > 0 && (
              <pre className="w-full max-h-40 overflow-y-auto rounded-md bg-muted px-3 py-2 text-xs font-mono text-foreground text-left whitespace-pre-wrap break-all">
                {outputLines.map((line, i) => (
                  <Fragment key={i}>
                    {i > 0 && "\n"}
                    {linkifyLine(line)}
                  </Fragment>
                ))}
              </pre>
            )}
          </div>
        ) : (
          <div className="space-y-2 py-2">
            {authError && <p className="text-sm text-destructive">{authError}</p>}
            {authMethods.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading authentication methods…</p>
            ) : (
              authMethods.map(
                (method: {
                  id: string;
                  name: string;
                  description?: string | null;
                  methodType: string;
                }) => (
                  <Button
                    key={method.id}
                    variant="outline"
                    className="w-full justify-start h-auto py-3 px-4"
                    onClick={() => void handleSelect(method.id, method.methodType)}
                  >
                    <div className="text-left">
                      <div className="font-medium">{method.name}</div>
                      {method.description && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {method.description}
                        </div>
                      )}
                    </div>
                  </Button>
                ),
              )
            )}
          </div>
        )}

        {!isInProgress && (
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
