import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { useReviewStore } from "../store/reviewStore";
import { parseDiffString } from "../utils/diffParser";
import { FileTree } from "./FileTree";
import { DiffViewer } from "./DiffViewer";
import { ApprovalForm } from "./ApprovalForm";

interface ReviewModalProps {
  taskId: number;
  taskName: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({
  taskId,
  taskName,
  isOpen,
  onClose,
}) => {
  const store = useReviewStore();
  const [showApprovalForm, setShowApprovalForm] = useState(false);

  // Fetch diff when modal opens
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const fetchDiff = async () => {
      try {
        store.openReview(taskId);

        // Call Tauri IPC command to get diff
        const diffString = await invoke<string>("get_diff_for_review", {
          task_id: taskId,
        });

        // Parse diff string into DiffFile array
        const diffFiles = parseDiffString(diffString);

        if (diffFiles.length === 0) {
          store.setError("No changes found in diff");
          return;
        }

        store.setDiffData(diffFiles);
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        store.setError(`Failed to fetch diff: ${errorMsg}`);
        console.error("Fetch diff error:", error);
      }
    };

    fetchDiff();
  }, [isOpen, taskId, store]);

  // Find currently selected file's diff data
  const selectedDiffFile = store.diffData.find(
    (f) => f.fileName === store.selectedFile
  );

  const handleRetry = async () => {
    try {
      store.setLoading(true);
      store.setError(null);

      const diffString = await invoke<string>("get_diff_for_review", {
        task_id: taskId,
      });

      const diffFiles = parseDiffString(diffString);

      if (diffFiles.length === 0) {
        store.setError("No changes found in diff");
        return;
      }

      store.setDiffData(diffFiles);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      store.setError(`Failed to fetch diff: ${errorMsg}`);
      console.error("Retry fetch diff error:", error);
    }
  };

  const handleClose = () => {
    store.closeReview();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogPortal>
        <DialogOverlay className="review-modal-overlay" />
        <DialogContent className="review-modal-content">
          <div className="review-modal-header">
            <div>
              <DialogTitle className="review-modal-title">
                Review Changes
              </DialogTitle>
              <p className="review-modal-subtitle">{taskName}</p>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                ✕
              </Button>
            </DialogClose>
          </div>

          <div className="review-modal-body">
            {store.error && (
              <div className="review-modal-error">
                <p className="review-modal-error-text">{store.error}</p>
                <Button onClick={handleRetry} className="review-modal-retry-button">
                  Retry
                </Button>
              </div>
            )}

            {!store.error && (
              <div className="review-modal-content-area">
                <FileTree
                  files={store.diffData}
                  selectedFile={store.selectedFile}
                  onSelectFile={(fileName) => store.selectFile(fileName)}
                />

                <DiffViewer
                  diffFile={selectedDiffFile || null}
                  loading={store.loading}
                  error={undefined}
                />
              </div>
            )}
          </div>

          {!showApprovalForm && (
            <div className="review-modal-footer">
              <Button
                onClick={handleClose}
                variant="outline"
              >
                Close
              </Button>
              <Button
                onClick={() => setShowApprovalForm(true)}
              >
                Proceed to Approval
              </Button>
            </div>
          )}

          {showApprovalForm && (
            <ApprovalForm
              taskId={taskId}
              diffFiles={store.diffData}
              onApprove={() => {
                setShowApprovalForm(false);
                handleClose();
              }}
              onClose={() => setShowApprovalForm(false)}
            />
          )}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};
