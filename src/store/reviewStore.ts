import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import { DiffFileWithName } from "@/types/review";

export interface ReviewState {
  currentTaskId: number | null;
  diffData: DiffFileWithName[];
  selectedFile: string | null;
  isLoading: boolean;
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
    isLoading: false,
    error: null,

    openReview: (taskId: number) =>
      set((state) => {
        state.currentTaskId = taskId;
        state.isLoading = true;
        state.error = null;
      }),

    closeReview: () =>
      set((state) => {
        state.currentTaskId = null;
        state.diffData = [];
        state.selectedFile = null;
        state.isLoading = false;
        state.error = null;
      }),

    selectFile: (fileName: string) =>
      set((state) => {
        state.selectedFile = fileName;
      }),

    setDiffData: (files: DiffFileWithName[]) =>
      set((state) => {
        state.diffData = files;
        state.isLoading = false;
        if (files.length > 0 && !state.selectedFile) {
          state.selectedFile = files[0].fileName;
        }
      }),

    setError: (msg: string | null) =>
      set((state) => {
        state.error = msg;
        state.isLoading = false;
      }),

    setLoading: (loading: boolean) =>
      set((state) => {
        state.isLoading = loading;
      }),
  })),
);

export const useReviewCurrentTaskId = () => useReviewStore((s) => s.currentTaskId);
export const useReviewDiffData = () => useReviewStore((s) => s.diffData);
export const useReviewSelectedFile = () => useReviewStore((s) => s.selectedFile);
export const useReviewIsLoading = () => useReviewStore((s) => s.isLoading);
export const useReviewError = () => useReviewStore((s) => s.error);
export const useReviewActions = () =>
  useReviewStore(
    useShallow((s) => ({
      openReview: s.openReview,
      closeReview: s.closeReview,
      selectFile: s.selectFile,
      setDiffData: s.setDiffData,
      setError: s.setError,
      setLoading: s.setLoading,
    })),
  );
