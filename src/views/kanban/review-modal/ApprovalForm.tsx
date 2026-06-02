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
  const [backlogComment, setBacklogComment] = useState("");
  const [resumeInstruction, setResumeInstruction] = useState("");
  const [cancelConfirmPending, setCancelConfirmPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { mutate: saveReview, isPending: isSavingReview } = useSaveTaskReviewMutation();
  const { mutate: approveAndMerge, isPending: isApproving } = useApproveTaskAndMergeMutation();
  const { mutate: rejectReview, isPending: isRejecting } = useRejectReviewMutation();

  const loading = isSavingReview || isApproving || isRejecting;

  const handleApprove = () => {
    setError(null);
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
    <div className="flex flex-col gap-4 overflow-y-auto border-t px-6 py-4">
      {/* Accept section */}
      <div className="flex flex-col gap-3 border-b pb-4">
        <h3 className="text-sm font-medium">Accept</h3>
        <div className="flex flex-col gap-2">
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
        <Button onClick={handleApprove} disabled={loading} className="mt-3">
          {isApproving || isSavingReview ? "Approving..." : "Approve"}
        </Button>
      </div>

      {/* Reject section */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Reject</h3>

        {/* Send to Backlog */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backlog-comment" className="text-sm font-medium">
            Send to Backlog
          </Label>
          <Textarea
            id="backlog-comment"
            placeholder="Optional comment..."
            value={backlogComment}
            onChange={(e) => setBacklogComment(e.target.value)}
            disabled={loading}
            rows={2}
          />
          <Button
            onClick={handleSendToBacklog}
            disabled={loading}
            variant="outline"
            className="mt-1"
          >
            {isRejecting ? "Sending..." : "Send to Backlog"}
          </Button>
        </div>

        {/* Resume with Instructions */}
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="resume-instruction" className="text-sm font-medium">
            Resume with Instructions
          </Label>
          <Textarea
            id="resume-instruction"
            placeholder="Required: describe what the agent should do..."
            value={resumeInstruction}
            onChange={(e) => setResumeInstruction(e.target.value)}
            disabled={loading}
            rows={3}
          />
          <Button
            onClick={handleResumeWithInstructions}
            disabled={loading || !resumeInstruction.trim()}
            variant="outline"
            className="mt-1"
          >
            {isRejecting ? "Sending..." : "Resume with Instructions"}
          </Button>
        </div>

        {/* Cancel Task */}
        <div className="mt-4 flex flex-col gap-1.5">
          <Button onClick={handleCancelTask} disabled={loading} variant="outline">
            {cancelConfirmPending
              ? "Confirm Cancel Task"
              : isRejecting
                ? "Cancelling..."
                : "Cancel Task"}
          </Button>
          {cancelConfirmPending && (
            <p className="mt-1 text-xs text-muted-foreground">
              Click again to confirm. This action cannot be undone.
            </p>
          )}
        </div>
      </div>

      {/* Per-file comments */}
      {diffFiles.length > 0 && (
        <div className="flex flex-col gap-3 border-t pt-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Files in this review ({diffFiles.length})
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {diffFiles.map((file) => (
                <div key={file.fileName} className="flex items-center">
                  <span className="font-mono text-xs text-muted-foreground">{file.fileName}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-end border-t pt-4">
        <Button onClick={onClose} disabled={loading} variant="outline">
          Back
        </Button>
      </div>
    </div>
  );
};
