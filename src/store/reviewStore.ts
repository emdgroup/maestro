import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { DiffFileWithName } from "../types/review";

export interface ReviewState {
  currentTaskId: number | null;
  diffData: DiffFileWithName[];
  selectedFile: string | null;
  loading: boolean;
  error: string | null;

  openReview: (taskId: number) => void;
  closeReview: () => void;
  selectFile: (fileName: string) => void;
  setDiffData: (files: DiffFileWithName[]) => void;
  setError: (msg: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useReviewStore = create<ReviewState>()(
  immer((set) => ({
    currentTaskId: null,
    diffData: [],
    selectedFile: null,
    loading: false,
    error: null,

    openReview: (taskId: number) =>
      set((state) => {
        state.currentTaskId = taskId;
        state.loading = true;
        state.error = null;
      }),

    closeReview: () =>
      set((state) => {
        state.currentTaskId = null;
        state.diffData = [];
        state.selectedFile = null;
        state.loading = false;
        state.error = null;
      }),

    selectFile: (fileName: string) =>
      set((state) => {
        state.selectedFile = fileName;
      }),

    setDiffData: (files: DiffFileWithName[]) =>
      set((state) => {
        state.diffData = files;
        state.loading = false;
        if (files.length > 0 && !state.selectedFile) {
          state.selectedFile = files[0].fileName;
        }
      }),

    setError: (msg: string | null) =>
      set((state) => {
        state.error = msg;
        state.loading = false;
      }),

    setLoading: (loading: boolean) =>
      set((state) => {
        state.loading = loading;
      }),
  }))
);
