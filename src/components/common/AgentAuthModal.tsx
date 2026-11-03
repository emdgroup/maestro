import React, { useState, Fragment } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { TerminalSquare } from "lucide-react";
import type { ConnectionKey } from "@/types/bindings";
import {
  startAuthTerminal,
  useAgentAuthInfoQuery,
  useAcpAuthenticateMutation,
} from "@/services/acp-auth.service";
import { useTauriEvent } from "@/services/tauri-events";
import { connectionChannelId } from "@/lib/connection-utils";
import { useNavigate } from "@/store/navigationStore";
import { useBoardActions } from "@/store/boardStore";
import { Spinner } from "@/ui/spinner";

interface AgentAuthModalProps {
  agentId: string;
  connection: ConnectionKey;
  open: boolean;
  onAuthSuccess: () => void;
  onClose: () => void;
  // Optional: when provided, terminal-type auth methods open a side-panel tab instead of using the mutation.
  authKey?: string;
  sessionId?: string | null;
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
  connection,
  open,
  onAuthSuccess,
  onClose,
  authKey,
  sessionId,
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

  // Each auth run starts with an empty log. Cleared during render rather than from the
  // effect below, which owns only the subscription to that run's output.
  const [loggedRun, setLoggedRun] = useState(authenticate.isPending);
  if (loggedRun !== authenticate.isPending) {
    setLoggedRun(authenticate.isPending);
    if (authenticate.isPending) setOutputLines([]);
  }

  // Only while a sign-in runs. Cancel-safe, so closing mid-sign-in cannot leak the listener.
  useTauriEvent<{ level: string; message: string }>(
    authenticate.isPending ? `acp://auth-output/${connectionChannelId(connection)}` : null,
    (payload) => setOutputLines((prev) => [...prev, payload.message]),
  );

  const authMethods = authInfo?.authMethods ?? [];

  async function handleSelect(methodId: string, methodType: string) {
    setAuthError(null);

    // Terminal methods with a task context open an interactive tab in the side panel.
    if (methodType === "terminal" && authKey != null && sessionId != null) {
      setIsStartingTerminal(true);
      try {
        const terminalId = await startAuthTerminal(agentId, methodId, connection, sessionId);
        navigate({ agentId: authKey });
        setAuthTerminalRunning(authKey, terminalId);
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

  const isInProgress = authenticate.isPending || isStartingTerminal;

  // When a terminal PTY is running: show info message (the terminal tab is in the agents panel).
  if (terminalState === "running" && authKey != null) {
    return (
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Sign in to {agentId}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground">
            <TerminalSquare className="w-6 h-6" />
            <span className="text-center">
              Authentication terminal is open. Complete the sign-in in the agent panel.
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
  if (terminalState === "interrupted" && authKey != null) {
    return (
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Sign in to {agentId}</DialogTitle>
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
          <DialogTitle>Sign in to {agentId}</DialogTitle>
        </DialogHeader>

        {isInProgress ? (
          <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground">
            <Spinner className="size-6" />
            <span>Authentication in progress. Follow any prompts in your browser or terminal.</span>
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
