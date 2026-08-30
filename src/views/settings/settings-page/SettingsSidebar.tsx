import { Search } from "lucide-react";
import { Input } from "@/ui/input";
import { cn } from "@/lib/utils";
import {
  searchSettings,
  SCOPE_ORDER,
  type SettingsPageDef,
  type SettingsScope,
} from "./settings-registry";

interface SettingsSidebarProps {
  pages: SettingsPageDef[];
  activeId: string;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Names for the scope headings — "PROJECT · maestro" rather than a bare "PROJECT". */
  connectionLabel: string;
  projectLabel: string;
}

export function SettingsSidebar({
  pages,
  activeId,
  onSelect,
  query,
  onQueryChange,
  connectionLabel,
  projectLabel,
}: SettingsSidebarProps) {
  const hits = searchSettings(pages, query);

  function headingFor(scope: SettingsScope): string {
    if (scope === "app") return "Application";
    if (scope === "connection")
      return connectionLabel ? `Connection · ${connectionLabel}` : "Connection";
    return projectLabel ? `Project · ${projectLabel}` : "Project";
  }

  return (
    // No right border: the content pane's own `border-l` is the seam, so the sidebar sits on
    // the same card surface as the header bar above it.
    <div className="flex w-56 shrink-0 flex-col bg-card">
      <div className="p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-3">
        {hits.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No settings match &ldquo;{query.trim()}&rdquo;
          </p>
        ) : (
          SCOPE_ORDER.map((scope) => {
            const inScope = hits.filter((hit) => hit.page.scope === scope);
            // A scope with nothing in it is absent rather than empty: an unopened project has
            // no project settings, and a search that excluded them all has none to show.
            if (inScope.length === 0) return null;

            return (
              <div key={scope} className="mb-3 last:mb-0">
                <p className="truncate px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  {headingFor(scope)}
                </p>
                <div className="space-y-0.5">
                  {inScope.map(({ page, matched }) => {
                    const Icon = page.icon;
                    const isActive = page.id === activeId;
                    return (
                      <button
                        key={page.id}
                        type="button"
                        onClick={() => onSelect(page.id)}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                          isActive
                            ? "bg-accent/10 text-foreground"
                            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        )}
                      >
                        <Icon className="mt-0.5 size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{page.label}</span>
                          {/* Why this page is in the results — without it a search for a control
                              name returns a page whose title says nothing about the match. */}
                          {matched.length > 0 && (
                            <span className="block truncate text-[10px] text-muted-foreground/70">
                              {matched.join(", ")}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </nav>
    </div>
  );
}
