import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { useReviewStore } from "@/store/reviewStore";
import { parseDiffString } from "@/lib";
import { FileTree } from "@/components/execution/FileTree";
import { DiffViewer } from "@/components/execution/DiffViewer";
import { ApprovalForm } from "./ApprovalForm";
import { X } from "lucide-react";
import { useDiffForReviewQuery } from "@/services/task.service";

interface ReviewModalProps {
  taskId: number;
  taskName: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({ taskId, taskName, isOpen, onClose }) => {
  const store = useReviewStore();
  const [showApprovalForm, setShowApprovalForm] = useState(false);

  // Query hook for fetching diff - only enabled when modal is open
  const { data: diffString, isLoading: isDiffLoading, error: diffError, refetch: refetchDiff } = useDiffForReviewQuery(isOpen ? taskId : null);

  // Process diff data when it arrives
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    store.openReview(taskId);

    if (diffError) {
      const errorMsg = diffError instanceof Error ? diffError.message : String(diffError);
      store.setError(`Failed to fetch diff: ${errorMsg}`);
      console.error("Fetch diff error:", diffError);
      return;
    }

    if (isDiffLoading) {
      return;
    }

    if (diffString) {
      // Parse diff string into DiffFile array
      const diffFiles = parseDiffString(diffString);

      if (diffFiles.length === 0) {
        store.setError("No changes found in diff");
        return;
      }

      store.setError(null);
      store.setDiffData(diffFiles);
    }
  }, [isOpen, taskId, diffString, isDiffLoading, diffError, store]);

  // Find currently selected file's diff data
  const selectedDiffFile = store.diffData.find((f) => f.fileName === store.selectedFile);

  const handleRetry = async () => {
    store.setError(null);
    await refetchDiff();
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
              <DialogTitle className="review-modal-title">Review Changes</DialogTitle>
              <p className="review-modal-subtitle">{taskName}</p>
            </div>
            <DialogClose
              render={
                <Button variant="ghost" size="sm" aria-label="Close">
                  <X className="size-3.5" />
                </Button>
              }
            />
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
              <Button onClick={handleClose} variant="outline">
                Close
              </Button>
              <Button onClick={() => setShowApprovalForm(true)}>Proceed to Approval</Button>
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
