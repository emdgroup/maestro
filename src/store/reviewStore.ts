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

    setViewedFiles: (taskId, files) =>
      set((state) => {
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
