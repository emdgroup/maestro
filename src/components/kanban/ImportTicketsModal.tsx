import { useState, useRef, useMemo } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { RefreshCw, Download, ExternalLink, Filter, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { ScrollArea } from "@/ui/scroll-area";
import { Separator } from "@/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
import { Spinner } from "@/ui/spinner";

import {
  slideVariants,
  PAGE_TRANSITION_DURATION,
  PAGE_TRANSITION_EASING,
} from "@/utils/constants/animations";

import {
  useFetchRemoteIssuesQuery,
  useImportTasksMutation,
  useUpdateTaskFromRemoteMutation,
  useDismissTaskChangeMutation,
  useTasksQuery,
  useProjectBranchesQuery,
} from "@/services/task.service";
import { useProjectIssueTrackingConfig, PROVIDER_NAMES } from "@/services/integration.service";

import type { RemoteIssue, Task } from "@/types/bindings";

// ── Tab definitions ──────────────────────────────────────────────────────────

type TabId = "available" | "imported" | "changed";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "available", label: "Available" },
  { id: "imported", label: "Imported" },
  { id: "changed", label: "Changed" },
];
const TAB_ORDER: TabId[] = ["available", "imported", "changed"];

// ── Props ────────────────────────────────────────────────────────────────────

interface ImportTicketsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
}

// ── Classification helpers ────────────────────────────────────────────────────

export function classifyIssues(
  tasks: Task[] | undefined,
  remoteIssues: RemoteIssue[] | undefined,
) {
  const importedExternalIds = new Set(
    (tasks ?? [])
      .filter((t) => t.is_imported && t.external_id)
      .map((t) => t.external_id!),
  );

  const remoteIssueMap = new Map(
    (remoteIssues ?? []).map((r) => [r.external_id, r]),
  );

  const available = (remoteIssues ?? []).filter(
    (r) => !importedExternalIds.has(r.external_id),
  );

  const importedTasks = (tasks ?? []).filter(
    (t) => t.is_imported && t.external_id && remoteIssueMap.has(t.external_id!),
  );

  const changedTasks = importedTasks.filter((t) => {
    const remote = remoteIssueMap.get(t.external_id!);
    return remote && remote.updated_at !== t.external_updated_at;
  });

  // All imported tasks for the Imported tab (show from DB even if remote fetch failed)
  const allImportedTasks = (tasks ?? []).filter((t) => t.is_imported);

  return { available, importedTasks: allImportedTasks, changedTasks, remoteIssueMap };
}

// ── Badge components ──────────────────────────────────────────────────────────

function ClassificationBadge({ type }: { type: "available" | "imported" | "changed" }) {
  const classes = {
    available: "bg-muted text-muted-foreground",
    imported: "bg-success/15 text-success",
    changed: "bg-warning/15 text-warning",
  };
  const labels = {
    available: "Available",
    imported: "Imported",
    changed: "! Changed",
  };
  return (
    <span
      className={`h-5 px-2 text-xs font-medium rounded-full inline-flex items-center ${classes[type]}`}
    >
      {labels[type]}
    </span>
  );
}

// ── Label pills ───────────────────────────────────────────────────────────────

function LabelPills({ labels }: { labels: string[] }) {
  const MAX_VISIBLE = 3;
  const visible = labels.slice(0, MAX_VISIBLE);
  const overflow = labels.length - MAX_VISIBLE;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map((label) => (
        <span
          key={label}
          className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
        >
          {label}
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-xs text-muted-foreground">+{overflow} more</span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ImportTicketsModal({
  isOpen,
  onClose,
  projectId,
}: ImportTicketsModalProps) {
  // ── Tab state ──
  const [activeTab, setActiveTab] = useState<TabId>("available");
  const [tabSlideDir, setTabSlideDir] = useState(1);
  const prevTabRef = useRef<TabId>("available");

  const handleTabClick = (tab: TabId) => {
    if (tab === prevTabRef.current) return;
    const prevIdx = TAB_ORDER.indexOf(prevTabRef.current);
    const newIdx = TAB_ORDER.indexOf(tab);
    setTabSlideDir(newIdx > prevIdx ? 1 : -1);
    prevTabRef.current = tab;
    setActiveTab(tab);
  };

  // ── Selection state ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── Label filter state ──
  const [activeLabels, setActiveLabels] = useState<Set<string>>(new Set());

  // ── Data fetching ──
  const {
    data: remoteIssues,
    isLoading: isRemoteLoading,
    isError: isRemoteError,
    error: remoteError,
    refetch,
  } = useFetchRemoteIssuesQuery(projectId, isOpen);

  const { data: tasks } = useTasksQuery(projectId);
  const { data: branchesResult } = useProjectBranchesQuery(projectId);
  const { data: issueTrackingConfig } = useProjectIssueTrackingConfig(projectId);

  // baseBranch: second element of branchesResult tuple, fallback "main"
  const baseBranch = branchesResult?.[1] ?? "main";

  // Provider display name + subtitle
  const providerName = issueTrackingConfig?.provider
    ? (PROVIDER_NAMES[issueTrackingConfig.provider] ?? issueTrackingConfig.provider)
    : "";
  const subtitle = providerName;

  // ── Classification ──
  const { available, importedTasks, changedTasks, remoteIssueMap } = useMemo(
    () => classifyIssues(tasks, remoteIssues),
    [tasks, remoteIssues],
  );

  // ── All unique labels from remote issues (for filter) ──
  const allLabels = useMemo(() => {
    const labelSet = new Set<string>();
    (remoteIssues ?? []).forEach((r) => r.labels.forEach((l) => labelSet.add(l)));
    return Array.from(labelSet).sort();
  }, [remoteIssues]);

  // ── Filtered available issues ──
  const filteredAvailable = useMemo(() => {
    if (activeLabels.size === 0) return available;
    return available.filter((r) => r.labels.some((l) => activeLabels.has(l)));
  }, [available, activeLabels]);

  // ── Mutations ──
  const importMutation = useImportTasksMutation();
  const updateMutation = useUpdateTaskFromRemoteMutation();
  const dismissMutation = useDismissTaskChangeMutation();

  // ── Handlers ──
  const toggleSelect = (externalId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) {
        next.delete(externalId);
      } else {
        next.add(externalId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredAvailable.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredAvailable.map((r) => r.external_id)));
    }
  };

  const handleImport = () => {
    const issuesToImport = filteredAvailable.filter((r) =>
      selectedIds.has(r.external_id),
    );
    if (issuesToImport.length === 0) return;
    importMutation.mutate(
      { projectId, issues: issuesToImport, baseBranch },
      {
        onSuccess: () => {
          setSelectedIds(new Set());
        },
      },
    );
  };

  const handleUpdate = (task: Task) => {
    const remote = remoteIssueMap.get(task.external_id!);
    if (!remote) return;
    updateMutation.mutate({ taskId: task.id, issue: remote });
  };

  const handleDismiss = (task: Task) => {
    const remote = remoteIssueMap.get(task.external_id!);
    if (!remote || !remote.updated_at) return;
    dismissMutation.mutate({ taskId: task.id, remoteUpdatedAt: remote.updated_at });
  };

  const toggleLabelFilter = (label: string) => {
    setActiveLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  // Tab counts
  const tabCounts: Record<TabId, number> = {
    available: filteredAvailable.length,
    imported: importedTasks.length,
    changed: changedTasks.length,
  };

  // ── Error message helper ──
  const errorMessage = isRemoteError
    ? remoteError instanceof Error
      ? remoteError.message
      : String(remoteError)
    : null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        showCloseButton={false}
        className="flex flex-col gap-0 p-0 h-[80vh] sm:max-w-2xl overflow-hidden"
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div>
            <DialogTitle className="text-sm font-medium">Import tickets</DialogTitle>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Refresh tickets"
                      onClick={() => void refetch()}
                      disabled={isRemoteLoading}
                    >
                      <RefreshCw
                        className={`size-4 ${isRemoteLoading ? "animate-spin" : ""}`}
                      />
                    </Button>
                  }
                />
                <TooltipContent side="bottom" sideOffset={8}>
                  {isRemoteLoading ? "Refreshing…" : "Refresh tickets"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* ── Animated tab bar ── */}
        <div className="shrink-0 px-6 pt-2 bg-muted/30 border-b">
          <LayoutGroup id="import-modal-tab-nav">
            <div className="grid grid-cols-3 rounded-lg bg-muted p-1 gap-1 mb-2">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabClick(tab.id)}
                    role="tab"
                    aria-selected={isActive}
                    className={`relative flex w-full items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium outline-none ${
                      isActive ? "" : "cursor-pointer hover:bg-background/50"
                    }`}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="import-modal-active-pill"
                        className="absolute inset-0 rounded-md bg-background shadow-sm"
                        transition={{ type: "spring", stiffness: 400, damping: 35 }}
                      />
                    )}
                    <motion.span
                      animate={{
                        color: isActive
                          ? "var(--accent)"
                          : "var(--muted-foreground)",
                      }}
                      transition={{ duration: 0.15 }}
                      className="relative z-10"
                    >
                      {tab.label} ({tabCounts[tab.id]})
                    </motion.span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </div>

        {/* ── Tab content ── */}
        <div
          className="flex-1 min-h-0 overflow-hidden relative"
          role="tabpanel"
          aria-label={activeTab}
        >
          <AnimatePresence initial={false} custom={tabSlideDir}>
            <motion.div
              key={activeTab}
              custom={tabSlideDir}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{
                duration: PAGE_TRANSITION_DURATION,
                ease: PAGE_TRANSITION_EASING,
              }}
              className="absolute inset-0 flex flex-col overflow-hidden"
            >
              {activeTab === "available" && (
                <AvailableTabContent
                  issues={filteredAvailable}
                  allLabels={allLabels}
                  activeLabels={activeLabels}
                  onToggleLabelFilter={toggleLabelFilter}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectAll}
                  isLoading={isRemoteLoading}
                  errorMessage={errorMessage}
                  onRetry={() => void refetch()}
                />
              )}
              {activeTab === "imported" && (
                <ImportedTabContent tasks={importedTasks} />
              )}
              {activeTab === "changed" && (
                <ChangedTabContent
                  tasks={changedTasks}
                  isLoading={isRemoteLoading}
                  errorMessage={errorMessage}
                  onRetry={() => void refetch()}
                  onUpdate={handleUpdate}
                  onDismiss={handleDismiss}
                  updatePending={updateMutation.isPending}
                  dismissPending={dismissMutation.isPending}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* ── Footer (Available tab only) ── */}
        {activeTab === "available" && (
          <>
            <Separator />
            <div className="flex items-center justify-between px-6 py-4 shrink-0">
              <span className="text-xs text-muted-foreground">
                {selectedIds.size === 1
                  ? "1 selected"
                  : `${selectedIds.size} selected`}
              </span>
              <Button
                variant="accent"
                size="sm"
                onClick={handleImport}
                disabled={selectedIds.size === 0 || importMutation.isPending}
              >
                {importMutation.isPending ? (
                  <>
                    <Spinner className="size-3" />
                    Importing…
                  </>
                ) : (
                  <>
                    <Download className="size-4" />
                    Import Selected
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Available Tab ─────────────────────────────────────────────────────────────

function AvailableTabContent({
  issues,
  allLabels,
  activeLabels,
  onToggleLabelFilter,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  isLoading,
  errorMessage,
  onRetry,
}: {
  issues: RemoteIssue[];
  allLabels: string[];
  activeLabels: Set<string>;
  onToggleLabelFilter: (label: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
}) {
  if (isLoading && issues.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 px-4">
        <p className="text-sm text-destructive text-center">
          Failed to load issues. Check your connection and try again.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 px-8 text-center">
        <p className="text-sm font-medium text-foreground">No open issues</p>
        <p className="text-xs text-muted-foreground">
          All issues from this provider have already been imported, or there are no open
          issues to show.
        </p>
      </div>
    );
  }

  const allSelected = issues.length > 0 && selectedIds.size === issues.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < issues.length;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
        <Popover>
          <PopoverTrigger
            className={`h-7 inline-flex items-center gap-1.5 px-3 text-sm rounded-md border border-border bg-background font-medium ${activeLabels.size > 0 ? "text-accent" : "text-foreground"}`}
          >
            <Filter className="size-3.5" />
            Filter
            {activeLabels.size > 0 && (
              <span className="ml-1 bg-accent text-accent-foreground text-xs rounded-full px-1.5">
                {activeLabels.size}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2">
            {allLabels.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-1">No labels</p>
            ) : (
              <div className="flex flex-col gap-1">
                {allLabels.map((label) => (
                  <label
                    key={label}
                    className="flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer hover:bg-muted"
                  >
                    <Checkbox
                      checked={activeLabels.has(label)}
                      onCheckedChange={() => onToggleLabelFilter(label)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Select-all row */}
      <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <Checkbox
          aria-label="Select all available issues"
          checked={allSelected}
          data-state={someSelected ? "indeterminate" : allSelected ? "checked" : "unchecked"}
          onCheckedChange={onToggleSelectAll}
        />
        <span className="text-xs text-muted-foreground">
          {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
        </span>
      </div>

      {/* Issue rows */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 p-4">
          {issues.map((issue) => {
            const isSelected = selectedIds.has(issue.external_id);
            return (
              <label
                key={issue.external_id}
                className={`flex items-center gap-3 rounded-lg border px-4 py-2 transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-accent/10 border-accent/40"
                    : "bg-card hover:bg-accent/5"
                }`}
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => onToggleSelect(issue.external_id)}
                />
                <span className="flex-1 text-sm font-medium text-foreground truncate">
                  {issue.title}
                </span>
                {issue.labels.length > 0 && <LabelPills labels={issue.labels} />}
                <ClassificationBadge type="available" />
              </label>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Imported Tab ──────────────────────────────────────────────────────────────

function ImportedTabContent({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 px-8 text-center">
        <p className="text-sm font-medium text-foreground">No imported tasks</p>
        <p className="text-xs text-muted-foreground">
          Issues you import will appear here. Go to the Available tab to get started.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-1 p-4">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="flex items-center gap-3 rounded-lg border px-4 py-2 bg-card"
          >
            <span className="flex-1 text-sm font-medium text-foreground truncate">
              {task.title}
            </span>
            {task.labels.length > 0 && <LabelPills labels={task.labels} />}
            <ClassificationBadge type="imported" />
            {task.external_url && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void openUrl(task.external_url!)}
                      >
                        <ExternalLink className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipContent>Open in browser</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ── Changed Tab ───────────────────────────────────────────────────────────────

function ChangedTabContent({
  tasks,
  isLoading,
  errorMessage,
  onRetry,
  onUpdate,
  onDismiss,
  updatePending,
  dismissPending,
}: {
  tasks: Task[];
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onUpdate: (task: Task) => void;
  onDismiss: (task: Task) => void;
  updatePending: boolean;
  dismissPending: boolean;
}) {
  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 px-4">
        <p className="text-sm text-destructive text-center">
          Cannot detect changes &mdash; remote fetch failed. Check your connection and try
          again.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 px-8 text-center">
        <p className="text-sm font-medium text-foreground">No changes detected</p>
        <p className="text-xs text-muted-foreground">
          Imported tasks are up to date with the latest data from your provider.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-1 p-4">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="flex items-center gap-3 rounded-lg border px-4 py-2 bg-card"
          >
            <span className="flex-1 text-sm font-medium text-foreground truncate">
              {task.title}
            </span>
            {task.labels.length > 0 && <LabelPills labels={task.labels} />}
            <ClassificationBadge type="changed" />
            <Button
              variant="outline"
              size="xs"
              onClick={() => onUpdate(task)}
              disabled={updatePending || dismissPending}
            >
              Update task
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={() => onDismiss(task)}
              disabled={updatePending || dismissPending}
            >
              Dismiss change
            </Button>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
