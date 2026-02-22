import { useState } from "react";
import { Task } from "../types/bindings";
import { ExecutionHistory } from "./ExecutionHistory";
import { TerminalComponent } from "./Terminal";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface TaskDetailProps {
  task: Task | null;
  projectPath: string;
  onClose: () => void;
}

export function TaskDetail({ task, projectPath, onClose }: TaskDetailProps) {
  const [activeTab, setActiveTab] = useState<"info" | "execution" | "terminal">("info");

  if (!task) return null;

  const showExecutionTab = ["InProgress", "Review", "Done"].includes(task.status);

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card border border-border rounded-lg shadow-lg max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">{task.name}</h2>
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
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Description</h3>
                <p className="text-sm text-muted-foreground">
                  {task.description || "No description"}
                </p>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Acceptance Criteria</h3>
                <p className="text-sm text-muted-foreground">
                  {task.acceptance_criteria || "No criteria"}
                </p>
              </div>

              {task.skills && task.skills.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Skills</h3>
                  <div className="flex flex-wrap gap-2">
                    {task.skills.map((skill) => (
                      <Badge key={skill} variant="secondary">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Status</h3>
                <Badge variant={task.status === "Done" ? "default" : "secondary"}>
                  {task.status}
                </Badge>
              </div>
            </div>
          )}

          {activeTab === "execution" && (
            <ExecutionHistory
              taskId={task.id}
              projectId={task.project_id}
              projectPath={projectPath}
              taskName={task.name}
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
