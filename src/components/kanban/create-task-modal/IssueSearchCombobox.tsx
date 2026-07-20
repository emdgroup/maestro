import { useState } from "react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/ui/tooltip";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import {
  Combobox,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Search } from "lucide-react";
import { Button } from "@/ui/button";
import { IssueTypeChip } from "@/components/kanban/shared/IssueTypeChip";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { PRIORITY_COLORS } from "@/utils/constants/priority";
import type { RemoteIssue, TaskPriority, ProjectIssueTrackingConfig } from "@/types/bindings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stripProviderPrefix, getIssueSearchPlaceholder } from "./create-task-utils";

interface IssueSearchComboboxProps {
  issueConfig: ProjectIssueTrackingConfig;
  selectedIssue: RemoteIssue | null;
  onSelect: (issue: RemoteIssue | null) => void;
  remoteIssues: RemoteIssue[];
  issuesFetching: boolean;
}

export function IssueSearchCombobox({
  issueConfig,
  selectedIssue,
  onSelect,
  remoteIssues,
  issuesFetching,
}: IssueSearchComboboxProps) {
  const [issueSearch, setIssueSearch] = useState("");

  const filteredIssues = remoteIssues.filter(
    (i) =>
      !issueSearch ||
      `#${i.external_id} ${i.title}`.toLowerCase().includes(issueSearch.toLowerCase()),
  );

  return (
    <Combobox
      value={selectedIssue ? `#${stripProviderPrefix(selectedIssue.external_id)}` : null}
      onValueChange={(val) => {
        if (!val) {
          onSelect(null);
          return;
        }
        const externalId = val.replace(/^#/, "").split(" ")[0];
        const issue = remoteIssues.find((i) => i.external_id === externalId);
        if (issue) onSelect(issue);
      }}
      filter={null}
      onInputValueChange={setIssueSearch}
    >
      <InputGroup className="w-full">
        <InputGroupAddon align="inline-start">
          <BrandIcon
            slug={issueConfig.provider}
            className="text-muted-foreground"
            width={14}
            height={14}
          />
        </InputGroupAddon>
        <ComboboxPrimitive.Input
          render={<InputGroupInput />}
          placeholder={getIssueSearchPlaceholder(issueConfig)}
        />
        <InputGroupAddon align="inline-end">
          <Search className="size-3.5 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
      <ComboboxContent className="min-w-(--anchor-width)" sideOffset={4}>
        <ComboboxList className="custom-scrollbar space-y-1">
          {issuesFetching && <ComboboxEmpty>Loading issues...</ComboboxEmpty>}
          {!issuesFetching && filteredIssues.length === 0 && (
            <ComboboxEmpty>No issues found.</ComboboxEmpty>
          )}
          <TooltipProvider delay={400}>
            {filteredIssues.map((issue) => (
              <Tooltip key={issue.external_id}>
                <ComboboxItem
                  value={`#${issue.external_id} ${issue.title}`}
                  className="p-0 px-1 rounded-md focus:outline-none hover:bg-transparent data-highlighted:bg-transparent data-highlighted:text-inherit data-highlighted:**:text-inherit not-data-[variant=destructive]:data-highlighted:**:text-inherit"
                >
                  <TooltipTrigger
                    render={<div />}
                    className="w-full rounded-md p-2 bg-muted/60 hover:bg-muted transition-colors cursor-default"
                  >
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            void openUrl(issue.url);
                          }}
                          className="text-[11px] !text-accent hover:underline shrink-0 h-auto p-0"
                        >
                          #{stripProviderPrefix(issue.external_id)}
                        </Button>
                        {issue.issue_type && <IssueTypeChip type={issue.issue_type} />}
                      </div>
                      {issue.priority && (
                        <div className="flex items-center gap-1 shrink-0">
                          <span
                            className="size-2 rounded-full"
                            style={{
                              backgroundColor:
                                PRIORITY_COLORS[issue.priority as TaskPriority] ?? "#4b5563",
                            }}
                          />
                          <span className="text-[10px] text-muted-foreground">
                            {issue.priority}
                          </span>
                        </div>
                      )}
                    </div>
                    <p className="text-sm truncate">{issue.title}</p>
                    {issue.labels.length > 0 && (
                      <div className="flex items-center gap-1 overflow-hidden mt-1 mask-[linear-gradient(to_right,black_80%,transparent_100%)]">
                        {issue.labels.map((label) => (
                          <span
                            key={label}
                            className="rounded px-1 py-0.5 text-[10px] border border-border text-muted-foreground shrink-0"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                  </TooltipTrigger>
                </ComboboxItem>
                <TooltipContent
                  side="right"
                  sideOffset={8}
                  className="w-72 p-3 bg-popover text-popover-foreground rounded-lg shadow-md ring-1 ring-foreground/10"
                >
                  <p className="text-sm font-medium leading-snug mb-2">{issue.title}</p>
                  {issue.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {issue.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded px-1.5 py-0.5 text-[10px] border border-border text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
