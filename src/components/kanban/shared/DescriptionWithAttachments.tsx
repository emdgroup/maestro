import { Paperclip, Upload } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { EditableField } from "@/components/kanban/task-detail-modal/EditableField";

interface DescriptionWithAttachmentsProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  isDragging: boolean;
  onPickFiles: () => void;
  placeholder?: string;
}

export function DescriptionWithAttachments({
  value,
  onSave,
  isEditable,
  isDragging,
  onPickFiles,
  placeholder,
}: DescriptionWithAttachmentsProps) {
  return (
    <div className="min-h-25 flex-1 flex flex-col gap-2 relative">
      <div
        className={cn("flex-1 min-h-0 overflow-y-auto custom-scrollbar", isDragging && "invisible")}
      >
        <EditableField
          multiline
          value={value}
          onSave={onSave}
          isEditable={isEditable}
          placeholder={placeholder}
        />
      </div>
      {isEditable && (
        <Button
          variant="ghost"
          onClick={onPickFiles}
          className={cn("w-fit text-muted-foreground/50", isDragging && "invisible")}
        >
          <Paperclip className="size-3" />
          Drop, paste or click to browse files
        </Button>
      )}
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-ring bg-muted/20 text-sm text-muted-foreground gap-1.5">
          <Upload className="size-3" />
          Drop files here
        </div>
      )}
    </div>
  );
}
