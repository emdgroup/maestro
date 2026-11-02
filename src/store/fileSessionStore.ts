import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ActiveSessionInfo } from "@/types/bindings";

/**
 * A session that only browses files: it sits in the session list beside the agents and shells, but
 * no process backs it, so it lives here rather than in the backend's list. `cwd` is the directory
 * it browses. Gone when the app closes, as a shell is.
 */
export type FileSession = Omit<ActiveSessionInfo, "execution_mode"> & {
  execution_mode: "files";
  /** An unsaved draft is open, so closing it has to ask first. */
  dirty: boolean;
};

/** One row of the session list. */
export type MonitorSession = ActiveSessionInfo | FileSession;

interface FileSessionState {
  sessions: FileSession[];
  /** Returns the new session's id. */
  add: (session: {
    projectId: number;
    name: string;
    cwd: string;
    branchName: string | null;
  }) => string;
  remove: (sessionId: string) => void;
  setDirty: (sessionId: string, dirty: boolean) => void;
}

export const useFileSessionStore = create<FileSessionState>()(
  immer((set) => ({
    sessions: [],
    add: ({ projectId, name, cwd, branchName }) => {
      const sessionId = crypto.randomUUID();
      set((state) => {
        state.sessions.push({
          session_id: sessionId,
          session_name: name,
          agent_id: null,
          execution_mode: "files",
          started_at: new Date().toISOString(),
          task_id: null,
          task_name: null,
          task_role: null,
          branch_name: branchName,
          acp_session_id: null,
          cwd,
          supports_session_list: false,
          supports_session_load: false,
          supports_session_close: false,
          supports_session_delete: false,
          project_id: projectId,
          dirty: false,
        });
      });
      return sessionId;
    },
    remove: (sessionId) =>
      set((state) => {
        state.sessions = state.sessions.filter((s) => s.session_id !== sessionId);
      }),
    setDirty: (sessionId, dirty) =>
      set((state) => {
        const session = state.sessions.find((s) => s.session_id === sessionId);
        if (session) session.dirty = dirty;
      }),
  })),
);
