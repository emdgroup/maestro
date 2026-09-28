import { useState } from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { Combobox, ComboboxContent, ComboboxList, ComboboxEmpty } from "@/ui/combobox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { ArrowLeftRight, ExternalLink, Search, X } from "lucide-react";
import { Button } from "@/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";
import { IssueTypeChip } from "@/components/kanban/shared/IssueTypeChip";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { PRIORITY_COLORS } from "@/utils/constants/priority";
import type { RemoteIssue, TaskPriority, ProjectIssueTrackingConfig } from "@/types/bindings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stripProviderPrefix, getIssueSearchPlaceholder } from "./create-task-utils";
import { cn } from "@/lib/utils";

interface IssueSearchComboboxProps {
  issueConfig: ProjectIssueTrackingConfig;
  selectedIssue: RemoteIssue | null;
  /** `null` removes the issue and clears what it filled in. */
  onSelect: (issue: RemoteIssue | null) => void;
  remoteIssues: RemoteIssue[];
  issuesFetching: boolean;
  /** What the popup lines up under: the dialog's content box, so it never leaves the dialog. */
  popupAnchor: React.RefObject<HTMLElement | null>;
}

function PriorityDot({ priority }: { priority: string }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: PRIORITY_COLORS[priority as TaskPriority] ?? "#4b5563" }}
    />
  );
}

/**
 * The Create Task header's issue control. Empty, it is an "Import issue" button whose popup
 * holds a search field and lists one issue per line beside a preview of the highlighted one, so
 * the body that will become the description is visible before it is chosen. Once an issue is
 * picked, the button becomes a chip: its number opens the issue, and the chip can pick another
 * or remove it.
 */
export function IssueSearchCombobox({
  issueConfig,
  selectedIssue,
  onSelect,
  remoteIssues,
  issuesFetching,
  popupAnchor,
}: IssueSearchComboboxProps) {
  const [issueSearch, setIssueSearch] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | undefined>();

  const query = issueSearch.toLowerCase();
  const filteredIssues = remoteIssues.filter(
    (i) => !query || `#${i.external_id} ${i.title}`.toLowerCase().includes(query),
  );
  const previewed =
    filteredIssues.find((i) => i.external_id === highlightedId) ?? filteredIssues[0] ?? null;

  return (
    <Combobox<string>
      value={null}
      onValueChange={(externalId) => {
        const issue = remoteIssues.find((i) => i.external_id === externalId);
        if (issue) onSelect(issue);
      }}
      onOpenChange={(open) => {
        // Every opening starts from the whole list, whatever the last search was.
        if (open) setIssueSearch("");
      }}
      // The pointer leaving the list clears the highlight; keep the last one so the preview
      // stays put while the pointer crosses over to it.
      onItemHighlighted={(id) => id !== undefined && setHighlightedId(id)}
      autoHighlight
      filter={null}
      onInputValueChange={setIssueSearch}
    >
      <div className="inline-flex">
        {selectedIssue ? (
          <div className="inline-flex h-7 items-center gap-0.5 rounded-md border border-border bg-muted/40 pr-0.5 text-xs">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="font-mono text-accent"
                    aria-label={`Open issue ${stripProviderPrefix(selectedIssue.external_id)} in browser`}
                    onClick={() => void openUrl(selectedIssue.url)}
                  />
                }
              >
                <BrandIcon
                  slug={issueConfig.provider}
                  className="shrink-0 text-muted-foreground"
                  width={12}
                  height={12}
                />
                #{stripProviderPrefix(selectedIssue.external_id)}
              </TooltipTrigger>
              <TooltipContent>Open in browser</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ComboboxPrimitive.Trigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground"
                        aria-label="Choose another issue"
                      />
                    }
                  />
                }
              >
                <ArrowLeftRight />
              </TooltipTrigger>
              <TooltipContent>Choose another issue</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove issue"
                    onClick={() => onSelect(null)}
                  />
                }
              >
                <X />
              </TooltipTrigger>
              <TooltipContent>Remove issue</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <ComboboxPrimitive.Trigger
            render={
              <Button type="button" variant="outline" size="xs" className="text-muted-foreground" />
            }
          >
            <BrandIcon slug={issueConfig.provider} width={12} height={12} />
            Import issue
          </ComboboxPrimitive.Trigger>
        )}
      </div>
      <ComboboxContent
        anchor={popupAnchor}
        className="flex flex-col gap-2 p-2 text-sm"
        sideOffset={6}
      >
        {/* Wrapped so ComboboxContent's rules for a direct-child input group, sized for a much
            smaller list, do not apply. */}
        <div>
          <InputGroup className="h-9 border-transparent bg-muted/60 shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0">
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5 opacity-50" />
            </InputGroupAddon>
            <ComboboxPrimitive.Input
              render={<InputGroupInput />}
              placeholder={getIssueSearchPlaceholder(issueConfig)}
            />
          </InputGroup>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_16rem] gap-2">
          <ComboboxList className="space-y-0.5 p-0">
            {issuesFetching && <ComboboxEmpty>Loading issues...</ComboboxEmpty>}
            {!issuesFetching && filteredIssues.length === 0 && (
              <ComboboxEmpty>No issues found.</ComboboxEmpty>
            )}
            {filteredIssues.map((issue) => (
              <ComboboxPrimitive.Item
                key={issue.external_id}
                value={issue.external_id}
                className={cn(
                  "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 outline-hidden select-none",
                  issue === previewed && "bg-muted text-foreground",
                )}
              >
                <span className="w-14 shrink-0 truncate font-mono text-[11px] text-accent">
                  #{stripProviderPrefix(issue.external_id)}
                </span>
                <span className="flex-1 truncate">{issue.title}</span>
                {issue.priority && <PriorityDot priority={issue.priority} />}
              </ComboboxPrimitive.Item>
            ))}
          </ComboboxList>
          <div className="flex min-h-40 flex-col gap-2 rounded-md bg-muted/40 p-3">
            {previewed ? (
              <>
                <div className="flex items-center gap-2">
                  {previewed.issue_type && <IssueTypeChip type={previewed.issue_type} />}
                  {previewed.priority && (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <PriorityDot priority={previewed.priority} />
                      {previewed.priority}
                    </span>
                  )}
                  <span className="flex-1" />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground"
                          aria-label="Open in browser"
                          onClick={() => void openUrl(previewed.url)}
                        />
                      }
                    >
                      <ExternalLink />
                    </TooltipTrigger>
                    <TooltipContent>Open in browser</TooltipContent>
                  </Tooltip>
                </div>
                <p className="font-medium leading-snug text-foreground">{previewed.title}</p>
                {previewed.body && (
                  <p className="line-clamp-6 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                    {previewed.body}
                  </p>
                )}
                {previewed.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {previewed.labels.map((label) => (
                      <span
                        key={label}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      </ComboboxContent>
    </Combobox>
  );
}
