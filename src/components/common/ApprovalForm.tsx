import React, { useState } from "react";
import { DiffFileWithName } from "@/types/review";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";
import {
  useSaveTaskReviewMutation,
  useApproveTaskAndMergeMutation,
  useRejectReviewMutation,
} from "@/services/task.service";

interface ApprovalFormProps {
  taskId: number;
  diffFiles: DiffFileWithName[];
  onApprove: () => void;
  onClose: () => void;
}

type MergeStrategy = "CommitAndMerge" | "CommitAndPush" | "CommitOnly";

const MERGE_STRATEGY_LABELS: Record<MergeStrategy, string> = {
  CommitAndMerge: "Commit + Merge",
  CommitAndPush: "Commit + Push",
  CommitOnly: "Commit only",
};

export const ApprovalForm: React.FC<ApprovalFormProps> = ({
  taskId,
  diffFiles,
  onApprove,
  onClose,
}) => {
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>("CommitAndMerge");

  // Backlog rejection state
  const [backlogComment, setBacklogComment] = useState("");

  // Resume with instructions state
  const [resumeInstruction, setResumeInstruction] = useState("");

  // Cancel confirmation state
  const [cancelConfirmPending, setCancelConfirmPending] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Mutation hooks
  const { mutate: saveReview, isPending: isSavingReview } = useSaveTaskReviewMutation();
  const { mutate: approveAndMerge, isPending: isApproving } = useApproveTaskAndMergeMutation();
  const { mutate: rejectReview, isPending: isRejecting } = useRejectReviewMutation();

  const loading = isSavingReview || isApproving || isRejecting;

  const handleApprove = () => {
    setError(null);

    // Save review feedback then trigger merge
    saveReview(
      {
        taskId,
        decision: "Approve",
        generalFeedback: null,
        perFileComments: null,
      },
      {
        onSuccess: () => {
          approveAndMerge(
            { taskId, mergeStrategy },
            {
              onSuccess: () => {
                setTimeout(onApprove, 500);
              },
            },
          );
        },
      },
    );
  };

  const handleSendToBacklog = () => {
    setError(null);
    rejectReview(
      {
        taskId,
        action: "SendToBacklog",
        instruction: backlogComment.trim() || undefined,
      },
      {
        onSuccess: () => {
          onClose();
        },
      },
    );
  };

  const handleResumeWithInstructions = () => {
    if (!resumeInstruction.trim()) {
      setError("Instructions are required when resuming the task.");
      return;
    }
    setError(null);
    rejectReview(
      {
        taskId,
        action: "ResumeWithInstructions",
        instruction: resumeInstruction.trim(),
      },
      {
        onSuccess: () => {
          onClose();
        },
      },
    );
  };

  const handleCancelTask = () => {
    if (!cancelConfirmPending) {
      setCancelConfirmPending(true);
      return;
    }
    setError(null);
    rejectReview(
      { taskId, action: "CancelTask" },
      {
        onSuccess: () => {
          onClose();
        },
      },
    );
  };

  return (
    <div className="approval-form">
      {/* Accept section */}
      <div className="approval-form-section">
        <h3 className="approval-form-heading">Accept</h3>
        <div className="approval-form-radio-group">
          {(Object.keys(MERGE_STRATEGY_LABELS) as MergeStrategy[]).map((strategy) => (
            <div key={strategy} className="flex items-center space-x-2">
              <input
                id={`strategy-${strategy}`}
                type="radio"
                name="mergeStrategy"
                value={strategy}
                checked={mergeStrategy === strategy}
                onChange={() => setMergeStrategy(strategy)}
                disabled={loading}
                className="h-4 w-4"
              />
              <Label htmlFor={`strategy-${strategy}`} className="cursor-pointer">
                {MERGE_STRATEGY_LABELS[strategy]}
              </Label>
            </div>
          ))}
        </div>
        <Button
          onClick={handleApprove}
          disabled={loading}
          className="approval-form-approve-btn mt-3"
        >
          {isApproving || isSavingReview ? "Approving..." : "Approve"}
        </Button>
      </div>

      {/* Reject section */}
      <div className="approval-form-section">
        <h3 className="approval-form-heading">Reject</h3>

        {/* Send to Backlog */}
        <div className="approval-form-reject-action">
          <Label htmlFor="backlog-comment" className="approval-form-reject-label">
            Send to Backlog
          </Label>
          <Textarea
            id="backlog-comment"
            placeholder="Optional comment..."
            value={backlogComment}
            onChange={(e) => setBacklogComment(e.target.value)}
            disabled={loading}
            rows={2}
            className="approval-form-textarea"
          />
          <Button
            onClick={handleSendToBacklog}
            disabled={loading}
            variant="outline"
            className="approval-form-reject-btn mt-1"
          >
            {isRejecting ? "Sending..." : "Send to Backlog"}
          </Button>
        </div>

        {/* Resume with Instructions */}
        <div className="approval-form-reject-action mt-4">
          <Label htmlFor="resume-instruction" className="approval-form-reject-label">
            Resume with Instructions
          </Label>
          <Textarea
            id="resume-instruction"
            placeholder="Required: describe what the agent should do..."
            value={resumeInstruction}
            onChange={(e) => setResumeInstruction(e.target.value)}
            disabled={loading}
            rows={3}
            className="approval-form-textarea"
          />
          <Button
            onClick={handleResumeWithInstructions}
            disabled={loading || !resumeInstruction.trim()}
            variant="outline"
            className="approval-form-reject-btn mt-1"
          >
            {isRejecting ? "Sending..." : "Resume with Instructions"}
          </Button>
        </div>

        {/* Cancel Task */}
        <div className="approval-form-reject-action mt-4">
          <Button
            onClick={handleCancelTask}
            disabled={loading}
            variant="outline"
            className="approval-form-cancel-btn"
          >
            {cancelConfirmPending
              ? "Confirm Cancel Task"
              : isRejecting
                ? "Cancelling..."
                : "Cancel Task"}
          </Button>
          {cancelConfirmPending && (
            <p className="approval-form-cancel-confirm-text mt-1 text-xs text-muted-foreground">
              Click again to confirm. This action cannot be undone.
            </p>
          )}
        </div>
      </div>

      {/* Per-file comments (kept for reference, collapsed by default) */}
      {diffFiles.length > 0 && (
        <div className="approval-form-section">
          <details className="approval-form-details">
            <summary className="approval-form-summary">
              Files in this review ({diffFiles.length})
            </summary>
            <div className="approval-form-per-file">
              {diffFiles.map((file) => (
                <div key={file.fileName} className="approval-form-file-comment">
                  <span className="approval-form-file-name">{file.fileName}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {error && <div className="approval-form-error">{error}</div>}

      <div className="approval-form-actions">
        <Button onClick={onClose} disabled={loading} variant="outline">
          Back
        </Button>
      </div>
    </div>
  );
};
