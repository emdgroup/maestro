import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { PendingComment } from "@/components/execution/diff/DiffViewer";

interface ReviewState {
  viewedFiles: Record<number, string[]>;
  comments: Record<number, PendingComment[]>;
}

interface ReviewActions {
  getViewedFiles: (taskId: number) => Set<string>;
  getComments: (taskId: number) => PendingComment[];
  setViewedFiles: (taskId: number, files: Set<string>) => void;
  setComments: (taskId: number, comments: PendingComment[]) => void;
  clearTask: (taskId: number) => void;
}

export const useReviewStore = create<ReviewState & ReviewActions>()(
  immer((set, get) => ({
    viewedFiles: {},
    comments: {},

    getViewedFiles: (taskId) => new Set(get().viewedFiles[taskId] ?? []),
    getComments: (taskId) => get().comments[taskId] ?? [],

    // Idempotent on purpose. Both setters are driven by effects that watch the value they write,
    // so a write that changes nothing must not produce a new state object: subscribers re-render,
    // the effect re-runs, and the pair spins until React gives up (error #185).
    setViewedFiles: (taskId, files) =>
      set((state) => {
        const current = state.viewedFiles[taskId];
        if (current?.length === files.size && current.every((path) => files.has(path))) return;
        state.viewedFiles[taskId] = [...files];
      }),

    setComments: (taskId, comments) =>
      set((state) => {
        state.comments[taskId] = comments;
      }),

    clearTask: (taskId) =>
      set((state) => {
        delete state.viewedFiles[taskId];
        delete state.comments[taskId];
      }),
  })),
);
