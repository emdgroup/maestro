import { useState } from "react";
import { Bot, User } from "lucide-react";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/lib/utils.ts";
import type { TaskComment } from "@/types/bindings";
import { useTaskCommentsQuery, useAddTaskNoteMutation } from "@/services/task.service";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useSelectedProject } from "@/store/projectStore";

/// What each kind of entry is called on screen. Unknown kinds render as themselves rather than
/// being dropped: the pipeline gains kinds as roles land, and a thread written by a newer build
/// must still be readable by an older one.
const KIND_LABELS: Record<string, string> = {
  proposal: "Proposal",
  plan: "Plan",
  verdict: "Review verdict",
  outcome: "Outcome",
  note: "Note",
};

function entryLabel(comment: TaskComment): string {
  const kind = KIND_LABELS[comment.kind] ?? comment.kind;
  return comment.phase ? `${kind} · ${comment.phase}` : kind;
}

function Entry({ comment }: { comment: TaskComment }) {
  const fromAgent = comment.author === "agent";
  const projectId = useSelectedProject()?.id;

  return (
    <div className="flex gap-2 text-sm">
      <div
        className={cn(
          "size-6 rounded-full shrink-0 flex items-center justify-center",
          fromAgent ? "bg-accent/20 text-accent" : "bg-muted text-muted-foreground",
        )}
      >
        {fromAgent ? <Bot className="size-3.5" /> : <User className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span className="font-bold">{entryLabel(comment)}</span>
          <span>{new Date(comment.created_at).toLocaleString()}</span>
        </div>
        {comment.body ? (
          // Agents write markdown — plans and refined descriptions arrive with headings, tables and
          // fenced code. Rendered as preformatted text they read as raw pipes and hashes, which is
          // the opposite of what the gate above them is asking the user to judge.
          <div className="break-words text-foreground/90">
            <MarkdownBlock text={comment.body} projectId={projectId} />
          </div>
        ) : (
          // An entry whose content lives outside the database. Nothing produces these yet; the
          // branch exists so that moving artifacts out later is not also a UI change.
          <p className="italic text-muted-foreground">
            Stored separately{comment.external_ref ? ` (${comment.external_ref})` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The task's outcome thread: what each phase concluded, plus the user's own notes.
 *
 * Not a transcript. The live conversation is in the session and reachable by Join while the
 * session lives; this is what is left afterwards, which is why it is the only record a Done or
 * archived task has.
 */
export function OutcomeThread({ taskId }: { taskId: number }) {
  const { data: comments = [], isLoading } = useTaskCommentsQuery(taskId);
  const addNote = useAddTaskNoteMutation();
  const [draft, setDraft] = useState("");

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    addNote.mutate({ taskId, body }, { onSuccess: () => setDraft("") });
  };

  return (
    // Capped and scrolled rather than sized to its content. An entry is a whole plan or a whole
    // refined description, and letting the thread take the height it wants starved the description
    // above it — which is `flex-1`, so it is the one that gives — down to a single clipped line,
    // and ran the last entry underneath the footer.
    <div className="shrink-0 flex flex-col min-h-0 max-h-72 gap-3 pt-3 border-t border-border">
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground shrink-0">
        Outcome
      </h3>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing recorded yet. An agent's closing message lands here when a phase finishes.
        </p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-3 pr-1">
          {comments.map((comment) => (
            <Entry key={comment.id} comment={comment} />
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add a note…"
          rows={2}
          className="text-sm"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={submit}
          disabled={addNote.isPending || draft.trim().length === 0}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
