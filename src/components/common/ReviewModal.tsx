import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "@/ui/dialog";
import { Button } from "@/ui/button";
import {
  useReviewDiffData,
  useReviewSelectedFile,
  useReviewIsLoading,
  useReviewError,
  useReviewActions,
} from "@/store/reviewStore";
import { parseDiffString } from "@/lib/diff-utils";
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
  const diffData = useReviewDiffData();
  const selectedFile = useReviewSelectedFile();
  const isReviewLoading = useReviewIsLoading();
  const reviewError = useReviewError();
  const { openReview, closeReview, selectFile, setDiffData, setError } = useReviewActions();
  const [showApprovalForm, setShowApprovalForm] = useState(false);

  const {
    data: diffString,
    isLoading: isDiffLoading,
    error: diffError,
    refetch: refetchDiff,
  } = useDiffForReviewQuery(isOpen ? taskId : null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    openReview(taskId);

    if (diffError) {
      const errorMsg = diffError instanceof Error ? diffError.message : String(diffError);
      setError(`Failed to fetch diff: ${errorMsg}`);
      console.error("Fetch diff error:", diffError);
      return;
    }

    if (isDiffLoading) {
      return;
    }

    if (diffString) {
      const diffFiles = parseDiffString(diffString);

      if (diffFiles.length === 0) {
        setError("No changes found in diff");
        return;
      }

      setError(null);
      setDiffData(diffFiles);
    }
  }, [isOpen, taskId, diffString, isDiffLoading, diffError, openReview, setError, setDiffData]);

  const selectedDiffFile = diffData.find((f) => f.fileName === selectedFile);

  const handleRetry = async () => {
    setError(null);
    await refetchDiff();
  };

  const handleClose = () => {
    closeReview();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent showCloseButton={false} className="flex h-[85vh] max-w-5xl flex-col gap-0 p-0">
        <div className="flex shrink-0 items-start justify-between border-b px-6 py-4">
          <div>
            <DialogTitle>Review Changes</DialogTitle>
            <p className="mt-0.5 text-sm text-muted-foreground">{taskName}</p>
          </div>
          <DialogClose
            render={
              <Button variant="ghost" size="sm" aria-label="Close">
                <X className="size-3.5" />
              </Button>
            }
          />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {reviewError && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm text-destructive">{reviewError}</p>
              <Button onClick={handleRetry}>Retry</Button>
            </div>
          )}

          {!reviewError && (
            <div className="flex h-full">
              <FileTree
                files={diffData}
                selectedFile={selectedFile}
                onSelectFile={(fileName) => selectFile(fileName)}
              />

              <DiffViewer
                diffFile={selectedDiffFile || null}
                loading={isReviewLoading}
                error={undefined}
              />
            </div>
          )}
        </div>

        {!showApprovalForm && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
            <Button onClick={handleClose} variant="outline">
              Close
            </Button>
            <Button onClick={() => setShowApprovalForm(true)}>Proceed to Approval</Button>
          </div>
        )}

        {showApprovalForm && (
          <ApprovalForm
            taskId={taskId}
            diffFiles={diffData}
            onApprove={() => {
              setShowApprovalForm(false);
              handleClose();
            }}
            onClose={() => setShowApprovalForm(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
