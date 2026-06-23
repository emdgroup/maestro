import { Paperclip } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { DescriptionField } from "@/components/kanban/task-detail-modal/DescriptionField";

interface DescriptionWithAttachmentsProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  isDragging: boolean;
  onPickFiles: () => void;
  placeholder?: string;
  projectId?: number;
}

export function DescriptionWithAttachments({
  value,
  onSave,
  isEditable,
  isDragging,
  onPickFiles,
  placeholder,
  projectId,
}: DescriptionWithAttachmentsProps) {
  return (
    <div className="min-h-40 flex-1 flex flex-col gap-2 relative">
      <div
        className={cn("flex-1 min-h-0 overflow-y-auto custom-scrollbar", isDragging && "invisible")}
      >
        <DescriptionField
          value={value}
          onSave={onSave}
          isEditable={isEditable}
          placeholder={placeholder}
          projectId={projectId}
        />
      </div>
      {isEditable && (
        <Button variant="ghost" onClick={onPickFiles} className={isDragging ? "invisible" : ""}>
          <Paperclip className="size-3" />
          Drop, paste or browse attachments
        </Button>
      )}
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-ring bg-muted/20">
          <p className="text-sm text-muted-foreground">Drop files here</p>
        </div>
      )}
    </div>
  );
}
