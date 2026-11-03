import { createContext, useContext } from "react";
import type { ArtifactFile, ConnectionKey } from "@/types/bindings";
import type { CanvasSurface, PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { PendingCanvasAwait } from "@/components/execution/activity/canvas/await-matching";
import type { Annotation } from "@/store/annotationStore";
import type { TabKind } from "./useSidePanelTabs";

/**
 * What the session's side panel shows and does, provided by `AgentActivityPanel` and read by the
 * tab contents. `ExecutionSidePanel`, in between, only lays the tabs out and never needed these.
 */
export interface SessionPanelValue {
  sessionId: string;
  /** The session is on screen, which is what polling and drag-and-drop are gated on. */
  isSessionActive: boolean;
  subagentItems: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
  /** Set while a plan is awaiting an answer: the tab reads and annotates it, the stream card
   *  answers it. Only the send button's wording depends on this. */
  sidePanelPlan: { requestId: string; payload: Record<string, unknown> } | null;
  canvasMap: Map<string, CanvasSurface>;
  latestCanvasSurfaceId: string | null;
  /** Open `canvas_await` calls, which make a surface's controls answer rather than just record. */
  pendingCanvasAwaits: PendingCanvasAwait[];
  onCanvasEvent: (requestId: string | null, event: unknown) => void;
  /** Drops the surface from this session's carousel. Its autosaved file is deleted alongside. */
  onCloseCanvas: (surfaceId: string) => void;
  /** Takes a `.html` file on *this* machine and brings it in as a surface. */
  onImportCanvas: (path: string) => void;
  workingFiles: ArtifactFile[];
  taskId: number | null;
  workspacePath: string;
  connection: ConnectionKey;
  planEntries?: PlanEntry[] | null;
  planTitle?: string | null;
  onOpenTabKind: (kind: TabKind) => void;
  /** Opens a path (absolute, or project-relative) in a Files tab. */
  onOpenFile: (path: string) => void;
  onSpawnShell?: () => Promise<string | null>;
  terminalBuffers?: Map<string, string>;
  onSendAnnotations: (annotations: Annotation[]) => void;
  /** The agent is mid-turn, so a prompt would be dropped (see useMessageSender.handleSend). */
  isProcessing?: boolean;
  /** The agent takes image blocks, so a canvas region is worth capturing. */
  canSendImages?: boolean;
  /** Puts text in the composer without sending it. Absent when there is no live agent to ask. */
  onSeedPrompt?: (text: string) => void;
}

export const SessionPanelContext = createContext<SessionPanelValue | null>(null);

export function useSessionPanel(): SessionPanelValue {
  const value = useContext(SessionPanelContext);
  if (!value) throw new Error("useSessionPanel must be used within SessionPanelContext");
  return value;
}
