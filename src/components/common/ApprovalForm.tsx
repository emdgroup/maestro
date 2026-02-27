import React, { useState } from "react";
import { DiffFileWithName } from "@/types/review";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";
import { useSaveTaskReviewMutation, useApproveTaskAndMergeMutation, useRequestChangesMutation } from "@/services/task.service";

interface ApprovalFormProps {
  taskId: number;
  diffFiles: DiffFileWithName[];
  onApprove: () => void;
  onClose: () => void;
}

type Decision = "Approve" | "RequestChanges" | null;

export const ApprovalForm: React.FC<ApprovalFormProps> = ({
  taskId,
  diffFiles,
  onApprove,
  onClose,
}) => {
  const [decision, setDecision] = useState<Decision>(null);
  const [generalFeedback, setGeneralFeedback] = useState("");
  const [perFileComments, setPerFileComments] = useState<Map<string, string>>(new Map());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Mutation hooks
  const { mutate: saveReview, isPending: isSavingReview } = useSaveTaskReviewMutation();
  const { mutate: approveAndMerge, isPending: isApproving } = useApproveTaskAndMergeMutation();
  const { mutate: requestChanges, isPending: isRequestingChanges } = useRequestChangesMutation();

  const loading = isSavingReview || isApproving || isRequestingChanges;

  const toggleFileExpanded = (filePath: string) => {
    const updated = new Set(expandedFiles);
    if (updated.has(filePath)) {
      updated.delete(filePath);
    } else {
      updated.add(filePath);
    }
    setExpandedFiles(updated);
  };

  const updateFileComment = (filePath: string, comment: string) => {
    const updated = new Map(perFileComments);
    if (comment.trim()) {
      updated.set(filePath, comment);
    } else {
      updated.delete(filePath);
    }
    setPerFileComments(updated);
  };

  const handleSubmit = () => {
    if (!decision) {
      setError("Please select Approve or Request Changes");
      return;
    }

    setError(null);

    // Convert per-file comments map to array of tuples
    const perFileCommentsArray = Array.from(perFileComments.entries());

    if (decision === "Approve") {
      // 1. Save review feedback first
      saveReview(
        {
          taskId: taskId,
          decision: "Approve",
          generalFeedback: generalFeedback || null,
          perFileComments: perFileCommentsArray.length > 0 ? perFileCommentsArray : null,
        },
        {
          onSuccess: () => {
            // 2. Initiate merge process
            approveAndMerge(taskId, {
              onSuccess: () => {
                // Wait a moment then trigger onApprove callback to close modal
                setTimeout(onApprove, 500);
              },
            });
          },
        }
      );
    } else if (decision === "RequestChanges") {
      // Call request_changes handler
      requestChanges(
        {
          taskId: taskId,
          generalFeedback: generalFeedback || null,
          perFileComments: perFileCommentsArray.length > 0 ? perFileCommentsArray : null,
        },
        {
          onSuccess: () => {
            onClose();
          },
        }
      );
    }
  };

  return (
    <div className="approval-form">
      <div className="approval-form-section">
        <h3 className="approval-form-heading">Decision Required</h3>
        <div className="approval-form-radio-group">
          <div className="flex items-center space-x-2">
            <input
              id="decision-approve"
              type="radio"
              name="decision"
              value="Approve"
              checked={decision === "Approve"}
              onChange={() => setDecision("Approve")}
              disabled={loading}
              className="h-4 w-4"
            />
            <Label htmlFor="decision-approve" className="cursor-pointer">
              Approve
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <input
              id="decision-request"
              type="radio"
              name="decision"
              value="RequestChanges"
              checked={decision === "RequestChanges"}
              onChange={() => setDecision("RequestChanges")}
              disabled={loading}
              className="h-4 w-4"
            />
            <Label htmlFor="decision-request" className="cursor-pointer">
              Request Changes
            </Label>
          </div>
        </div>
      </div>

      <div className="approval-form-section">
        <Label htmlFor="general-feedback">General Feedback (Optional)</Label>
        <Textarea
          id="general-feedback"
          placeholder="Enter feedback for the developer..."
          value={generalFeedback}
          onChange={(e) => setGeneralFeedback(e.target.value)}
          disabled={loading}
          rows={4}
          className="approval-form-textarea"
        />
      </div>

      <div className="approval-form-section">
        <details className="approval-form-details">
          <summary className="approval-form-summary">
            Per-File Comments ({perFileComments.size} of {diffFiles.length} files)
          </summary>
          <div className="approval-form-per-file">
            {diffFiles.map((file) => (
              <div key={file.fileName} className="approval-form-file-comment">
                <button
                  className="approval-form-file-toggle"
                  onClick={() => toggleFileExpanded(file.fileName)}
                  disabled={loading}
                >
                  {expandedFiles.has(file.fileName) ? "▼" : "▶"}
                  <span className="approval-form-file-name">{file.fileName}</span>
                  {perFileComments.has(file.fileName) && (
                    <span className="approval-form-file-has-comment">●</span>
                  )}
                </button>
                {expandedFiles.has(file.fileName) && (
                  <Textarea
                    placeholder={`Comment on ${file.fileName}...`}
                    value={perFileComments.get(file.fileName) || ""}
                    onChange={(e) => updateFileComment(file.fileName, e.target.value)}
                    disabled={loading}
                    rows={3}
                    className="approval-form-file-textarea"
                  />
                )}
              </div>
            ))}
          </div>
        </details>
      </div>

      {error && <div className="approval-form-error">{error}</div>}

      <div className="approval-form-actions">
        <Button onClick={onClose} disabled={loading} variant="outline">
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={loading || !decision}>
          {loading ? "Saving..." : "Submit"}
        </Button>
      </div>
    </div>
  );
};
