import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";
import type { ConnectionKey, DiscoveredAgent, WorktreeWithStatus } from "@/types/bindings";
import { useSessionHistory } from "./useSessionHistory";
import { SessionHistorySidebar } from "./SessionHistorySidebar";
import { SessionHistoryList } from "./SessionHistoryList";
import { WorktreePicker } from "./WorktreePicker";

export interface SessionHistoryModalProps {
  open: boolean;
  agents: DiscoveredAgent[];
  defaultAgentId: string | null;
  repoPath: string;
  connection: ConnectionKey;
  projectId: number;
  worktrees: WorktreeWithStatus[];
  onClose: () => void;
  onSessionLoaded: (sessionKey: number) => void;
}

export function SessionHistoryModal(props: SessionHistoryModalProps) {
  const { open, agents, repoPath, worktrees, onClose } = props;
  const h = useSessionHistory(props);

  const agentName = agents.find((a) => a.id === h.agentId)?.name ?? "";

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="w-195 sm:max-w-195 h-140 max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 gap-2">
          <DialogTitle>Session History</DialogTitle>
        </DialogHeader>

        {/* Agent pills */}
        {agents.length > 0 && (
          <div className="px-3 py-2 border-b border-border shrink-0 overflow-x-auto">
            <div className="flex gap-1.5 min-w-max">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => h.setAgentId(agent.id)}
                  className={cn(
                    "h-8 px-3 rounded-md text-xs font-medium flex items-center gap-1.5 border transition-colors shrink-0",
                    h.agentId === agent.id
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-border/80 bg-transparent",
                  )}
                >
                  {hasBrandIcon(agent.id) ? (
                    <BrandIcon slug={agent.id} className="size-4 shrink-0" />
                  ) : (
                    agent.icon && (
                      <img
                        src={agent.icon}
                        className="size-4 rounded-sm shrink-0 dark:[filter:invert(1)]"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    )
                  )}
                  {agent.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          <SessionHistorySidebar
            preset={h.preset}
            onPresetChange={h.changePreset}
            customRange={h.customRange}
            onCustomRangeChange={h.setCustomRange}
            stagingRange={h.stagingRange}
            onStagingRangeChange={h.setStagingRange}
            calendarOpen={h.calendarOpen}
            onCalendarOpenChange={h.setCalendarOpen}
          />
          <SessionHistoryList
            entries={h.filtered}
            isLoading={h.isLoading}
            isError={h.isError}
            isFetching={h.isFetching}
            onRefetch={h.refetch}
            query={h.query}
            onQueryChange={h.setQuery}
            summaryLabel={h.summaryLabel}
            ticked={h.ticked}
            onToggleTick={h.toggleTick}
            onSetTicked={h.setTicked}
            onRowClick={h.handleRowClick}
            onOpenTicked={h.openTicked}
            loadMutationPending={h.loadMutation.isPending}
            agentName={agentName}
            renamingId={h.renamingId}
            renameValue={h.renameValue}
            renameInputRef={h.renameInputRef}
            onRenameValueChange={h.setRenameValue}
            onStartRename={h.startRename}
            onCommitRename={h.commitRename}
            onCancelRename={() => h.setRenamingId(null)}
          />
        </div>

        {h.pendingRestore && (
          <WorktreePicker
            pendingRestore={h.pendingRestore}
            repoPath={repoPath}
            filteredWorktrees={h.filteredWorktrees}
            worktreeFilter={h.worktreeFilter}
            onWorktreeFilterChange={h.setWorktreeFilter}
            showFilter={worktrees.length > 5}
            selectedWorktreePath={h.selectedWorktreePath}
            onSelectWorktreePath={h.setSelectedWorktreePath}
            onCommit={h.commitRestore}
            onCancel={() => h.setPendingRestore(null)}
            isPending={h.loadMutation.isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
