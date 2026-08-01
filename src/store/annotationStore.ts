import { useMemo } from "react";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

/**
 * A note the user left on the agent's work, waiting to be sent to the session.
 *
 * The `diff` variant is structurally a `PendingComment` (see DiffViewer), so it can be handed
 * to `DiffViewer` in review mode without an adapter. The `plan` variant anchors to text instead
 * of a line: `quote` is the selected string and `occurrence` disambiguates repeats of it.
 */
export type Annotation =
  | {
      id: string;
      kind: "diff";
      filePath: string;
      lineNumber: number;
      side: "old" | "new";
      text: string;
    }
  | { id: string; kind: "plan"; quote: string; occurrence: number; text: string };

/** The diff variant on its own — structurally a `PendingComment`, so DiffViewer accepts it. */
export type DiffAnnotation = Extract<Annotation, { kind: "diff" }>;

interface AnnotationState {
  bySession: Record<number, Annotation[]>;
}

interface AnnotationActions {
  getAnnotations: (sessionKey: number, kind?: Annotation["kind"]) => Annotation[];
  addAnnotation: (sessionKey: number, annotation: Annotation) => void;
  updateAnnotation: (sessionKey: number, id: string, text: string) => void;
  removeAnnotations: (sessionKey: number, ids: string[]) => void;
  clearSession: (sessionKey: number) => void;
}

export const useAnnotationStore = create<AnnotationState & AnnotationActions>()(
  immer((set, get) => ({
    bySession: {},

    getAnnotations: (sessionKey, kind) => {
      const list = get().bySession[sessionKey] ?? [];
      return kind ? list.filter((a) => a.kind === kind) : list;
    },

    addAnnotation: (sessionKey, annotation) =>
      set((state) => {
        const list = state.bySession[sessionKey] ?? [];
        list.push(annotation);
        state.bySession[sessionKey] = list;
      }),

    updateAnnotation: (sessionKey, id, text) =>
      set((state) => {
        const target = state.bySession[sessionKey]?.find((a) => a.id === id);
        if (target) target.text = text;
      }),

    removeAnnotations: (sessionKey, ids) =>
      set((state) => {
        const list = state.bySession[sessionKey];
        if (!list) return;
        state.bySession[sessionKey] = list.filter((a) => !ids.includes(a.id));
      }),

    clearSession: (sessionKey) =>
      set((state) => {
        delete state.bySession[sessionKey];
      }),
  })),
);

/**
 * Subscribing selector — components re-render when this session's annotations change.
 * Memoized so the identity only changes with the data: the plan highlight effect keys off it.
 */
export function useSessionAnnotations(sessionKey: number, kind?: Annotation["kind"]): Annotation[] {
  const list = useAnnotationStore((s) => s.bySession[sessionKey]);
  return useMemo(() => {
    if (!list) return EMPTY;
    return kind ? list.filter((a) => a.kind === kind) : list;
  }, [list, kind]);
}

const EMPTY: Annotation[] = [];
