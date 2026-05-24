import { useState } from "react";
import { Task } from "@/types/bindings";
import { ExecutionHistory } from "@/components/execution/ExecutionHistory";
import { TerminalComponent } from "@/components/execution/Terminal";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import {
  useUpdateTask,
  useTaskRelationshipsQuery,
  useAddTaskRelationshipMutation,
  useRemoveTaskRelationshipMutation,
  useTaskInstructionsQuery,
  useAddTaskInstructionMutation,
} from "@/services/task.service";

interface TaskDetailProps {
  task: Task | null;
  projectPath: string;
  onClose: () => void;
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  blocks: "Blocks",
  blocked_by: "Blocked by",
  relates_to: "Relates to",
};

function RelationshipsSection({ task }: { task: Task }) {
  const canEdit = task.status === "Backlog" || task.status === "Ready";
  const { data: relationships, isLoading } = useTaskRelationshipsQuery(task.id);
  const addRelationship = useAddTaskRelationshipMutation();
  const removeRelationship = useRemoveTaskRelationshipMutation();

  const [newRelType, setNewRelType] = useState("blocks");
  const [newRelTaskId, setNewRelTaskId] = useState("");

  function handleAddRelationship() {
    const toTaskId = parseInt(newRelTaskId, 10);
    if (!newRelTaskId || isNaN(toTaskId)) return;
    addRelationship.mutate(
      { fromTaskId: task.id, toTaskId, relationshipType: newRelType },
      {
        onSuccess: () => {
          setNewRelTaskId("");
        },
      },
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Relationships</h3>
      {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {!isLoading && (!relationships || relationships.length === 0) && (
        <p className="text-sm text-muted-foreground">No relationships</p>
      )}
      {relationships && relationships.length > 0 && (
        <ul className="space-y-1">
          {relationships.map((rel) => (
            <li key={rel.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {RELATIONSHIP_LABELS[rel.relationship_type] ?? rel.relationship_type}
                </span>{" "}
                task #{rel.to_task_id}
              </span>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                  onClick={() =>
                    removeRelationship.mutate({ relationshipId: rel.id, taskId: task.id })
                  }
                  disabled={removeRelationship.isPending}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="flex gap-2 pt-1">
          <select
            value={newRelType}
            onChange={(e) => setNewRelType(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="blocks">Blocks</option>
            <option value="blocked_by">Blocked by</option>
            <option value="relates_to">Relates to</option>
          </select>
          <input
            type="number"
            placeholder="Task ID"
            value={newRelTaskId}
            onChange={(e) => setNewRelTaskId(e.target.value)}
            className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground"
          />
          <Button
            size="sm"
            onClick={handleAddRelationship}
            disabled={addRelationship.isPending || !newRelTaskId}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function InstructionsSection({ task }: { task: Task }) {
  const canAdd = task.status === "InProgress" || task.status === "Review";
  const { data: instructions, isLoading } = useTaskInstructionsQuery(task.id);
  const addInstruction = useAddTaskInstructionMutation();

  const [newContent, setNewContent] = useState("");

  function handleAddInstruction() {
    if (!newContent.trim()) return;
    addInstruction.mutate(
      { taskId: task.id, content: newContent.trim(), source: "user" },
      {
        onSuccess: () => {
          setNewContent("");
        },
      },
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Instructions Log</h3>
      {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {!isLoading && (!instructions || instructions.length === 0) && (
        <p className="text-sm text-muted-foreground">No instructions logged</p>
      )}
      {instructions && instructions.length > 0 && (
        <ul className="space-y-2">
          {instructions.map((instr) => (
            <li key={instr.id} className="rounded-md border border-border bg-muted/30 p-2 text-sm">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  {instr.source}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(instr.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-foreground whitespace-pre-wrap">{instr.content}</p>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <div className="space-y-2 pt-1">
          <Textarea
            placeholder="Add an instruction for the agent..."
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={3}
            className="text-sm resize-none"
          />
          <Button
            size="sm"
            onClick={handleAddInstruction}
            disabled={addInstruction.isPending || !newContent.trim()}
          >
            Add Instruction
          </Button>
        </div>
      )}
    </div>
  );
}

export function TaskDetail({ task, projectPath, onClose }: TaskDetailProps) {
  const [activeTab, setActiveTab] = useState<"info" | "execution" | "terminal">("info");

  // Editable description state (only description is editable via current IPC)
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const updateTask = useUpdateTask();

  if (!task) return null;

  const isEditable = task.status === "Backlog" || task.status === "Ready";
  const showExecutionTab = ["InProgress", "Review", "Done"].includes(task.status);

  const descriptionValue = descriptionDraft !== null ? descriptionDraft : task.description;
  const descriptionChanged = descriptionDraft !== null && descriptionDraft !== task.description;

  function handleSaveDescription() {
    if (descriptionDraft === null) return;
    updateTask.mutate(
      { taskId: task!.id, updates: { description: descriptionDraft ?? undefined } },
      {
        onSuccess: () => {
          setDescriptionDraft(null);
        },
      },
    );
  }

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card border border-border rounded-lg shadow-lg max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">{task.title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            ✕
          </Button>
        </div>

        <div className="flex gap-1 px-4 pt-4 border-b border-border">
          <Button
            variant={activeTab === "info" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("info")}
            className="rounded-b-none"
          >
            Details
          </Button>
          {showExecutionTab && (
            <>
              <Button
                variant={activeTab === "execution" ? "default" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("execution")}
                className="rounded-b-none"
              >
                Execution
              </Button>
              <Button
                variant={activeTab === "terminal" ? "default" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("terminal")}
                className="rounded-b-none"
              >
                Terminal
              </Button>
            </>
          )}
        </div>

        <div className="flex-1 overflow-auto p-4">
          {activeTab === "info" && (
            <div className="space-y-6">
              {/* Description — editable in Backlog/Ready */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Description</h3>
                {isEditable ? (
                  <div className="space-y-2">
                    <Textarea
                      value={descriptionValue}
                      onChange={(e) => setDescriptionDraft(e.target.value)}
                      rows={4}
                      className="text-sm resize-none"
                      placeholder="No description"
                    />
                    {descriptionChanged && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={handleSaveDescription}
                          disabled={updateTask.isPending}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDescriptionDraft(null)}
                          disabled={updateTask.isPending}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {task.description || "No description"}
                  </p>
                )}
              </div>

              {/* Priority — read-only (backend expansion required for editing) */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Priority</h3>
                <Badge variant="secondary">{task.priority}</Badge>
              </div>

              {/* Base Branch — read-only (backend expansion required for editing) */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Base Branch</h3>
                <p className="text-sm text-muted-foreground font-mono">{task.base_branch}</p>
              </div>

              {/* Status — always read-only */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Status</h3>
                <Badge variant={task.status === "Done" ? "default" : "secondary"}>
                  {task.status}
                </Badge>
              </div>

              {/* Relationships section */}
              <RelationshipsSection task={task} />

              {/* Instructions Log section */}
              <InstructionsSection task={task} />
            </div>
          )}

          {activeTab === "execution" && (
            <ExecutionHistory
              taskId={task.id}
              projectId={task.project_id}
              projectPath={projectPath}
              taskName={task.title}
            />
          )}

          {activeTab === "terminal" && (
            <div className="flex-1 flex h-full overflow-hidden">
              <TerminalComponent taskId={task.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
