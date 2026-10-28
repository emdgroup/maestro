import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Lock, TriangleAlert, X } from "lucide-react";
import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { cn } from "@/lib/utils";
import { buildFileTree, type FileTreeNode } from "@/components/execution/diff/file-tree";
import { namedPaths } from "./LoopEditor";
import type { LoopDraft } from "./loop-draft";
import { hiddenMatcher, isRule, orderPatterns, type Hidden } from "./loop-state";

/** Files a check depends on without naming them: what its command runs through. */
const DEPENDS_ON: { command: RegExp; file: RegExp; why: string }[] = [
  {
    command: /\b(npm|pnpm|yarn|bun) run\b/,
    file: /^package\.json$/,
    why: "a check runs a script from it",
  },
  { command: /\bvitest\b/, file: /^vitest\.config\.[^/]+$/, why: "decides which tests run" },
  { command: /\bjest\b/, file: /^jest\.config\.[^/]+$/, why: "decides which tests run" },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How many files `pattern` hides on its own, or shows again for an exception. */
const matches = (pattern: string, files: string[]) => {
  const match = hiddenMatcher([pattern.replace(/^!/, "")]);
  return files.filter((f) => match(f).hidden).length;
};

/** The lock a row of the tree carries: shown where something is hidden, on hover elsewhere. */
function LockButton({
  state,
  label,
  locked,
  onClick,
}: {
  state: "on" | "part" | "off";
  label: string;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={locked}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded p-0.5",
        state === "on" && "text-warning",
        state === "part" && "text-warning/50",
        state === "off" && "text-muted-foreground opacity-0 group-hover:opacity-100",
        !locked && "hover:bg-muted",
        locked && state === "off" && "invisible",
      )}
    >
      <Lock className="size-3" />
    </button>
  );
}

/** One removable entry of a list on the left. */
function Entry({
  text,
  count,
  locked,
  onRemove,
}: {
  text: string;
  count?: number;
  locked: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/40">
      <span className="min-w-0 flex-1 truncate font-mono">{text}</span>
      {count !== undefined && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {plural(count, "file")}
          {count === 0 && <span className="ml-1 text-warning">matches nothing</span>}
        </span>
      )}
      {!locked && (
        <button
          type="button"
          aria-label={`Remove ${text}`}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * What the agent's copy of the branch leaves out: rules, paths picked in the tree, and exceptions
 * the agent sees anyway, all one ordered list of patterns. The tree shows the loop's branch as the
 * agent gets it, and flags a file a check depends on that it can still change. Fixed once the loop
 * has started, but for what accepting a proposal adds.
 */
export function HiddenFilesCard({
  value,
  onChange,
  files: listed,
  locked,
}: {
  value: LoopDraft;
  onChange: (patch: Partial<LoopDraft>) => void;
  /** Every file on the loop's branch; `undefined` while it loads. */
  files: string[] | undefined;
  locked: boolean;
}) {
  const files = useMemo(() => listed ?? [], [listed]);
  const patterns = value.sealedPaths;
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [adding, setAdding] = useState("");
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  const states = useMemo(() => {
    const match = hiddenMatcher(patterns);
    return new Map(files.map((f) => [f, match(f)]));
  }, [patterns, files]);
  const state = (f: string): Hidden => states.get(f) ?? { hidden: false, by: null };
  const hidden = files.filter((f) => state(f).hidden).length;

  // Per folder: how many files it holds, and how many of them are hidden.
  const folders = useMemo(() => {
    const counts = new Map<string, { all: number; hidden: number }>();
    for (const f of files) {
      const parts = f.split("/");
      for (let d = 1; d < parts.length; d++) {
        const dir = parts.slice(0, d).join("/");
        const count = counts.get(dir) ?? { all: 0, hidden: 0 };
        count.all++;
        if (states.get(f)?.hidden) count.hidden++;
        counts.set(dir, count);
      }
    }
    return counts;
  }, [files, states]);

  const named = namedPaths(value.checks, files);
  const builtinOn = named.length > 0 && named.every((p) => patterns.includes(p));
  const rules = patterns.filter(isRule);
  const picked = patterns.filter((p) => !isRule(p) && !p.startsWith("!") && !named.includes(p));
  const exceptions = patterns.filter((p) => p.startsWith("!"));
  const commands = value.checks
    .filter((c) => c.kind === "Command" || c.kind === "Setup")
    .map((c) => c.command);
  const depends = new Map<string, string>();
  for (const dep of DEPENDS_ON) {
    if (!commands.some((c) => dep.command.test(c))) continue;
    for (const f of files) if (dep.file.test(f)) depends.set(f, dep.why);
  }
  const gaps = [...depends.keys()].filter((f) => !state(f).hidden);
  const namer = (path: string) =>
    value.checks.find((c) => c.command.includes(path.replace(/\/$/, "")))?.label.trim();

  const save = (next: string[], dismiss: string[] = [], undismiss: string[] = []) =>
    onChange({
      sealedPaths: orderPatterns(next),
      dismissed: [...value.dismissed.filter((p) => !undismiss.includes(p)), ...dismiss],
    });
  const without = (gone: string[]) => patterns.filter((p) => !gone.includes(p));

  const toggleFile = (f: string) => {
    const s = state(f);
    if (s.hidden) {
      if (patterns.includes(f)) save(without([f]), [f]);
      else save([...patterns, `!${f}`]);
      return;
    }
    const next = s.by?.startsWith("!") ? without([s.by]) : patterns;
    save(hiddenMatcher(next)(f).hidden ? next : [...next, f], [], [f]);
  };
  const toggleFolder = (dir: string) => {
    const count = folders.get(dir);
    if (!count) return;
    if (count.hidden === count.all) {
      const next = without([`${dir}/`, dir]);
      const match = hiddenMatcher(next);
      const still = files.some((f) => f.startsWith(`${dir}/`) && match(f).hidden);
      save(still ? [...next, `!${dir}/`] : next, [`${dir}/`]);
      return;
    }
    const inside = (p: string) => p.replace(/^!/, "").startsWith(`${dir}/`) || p === `!${dir}`;
    save([...patterns.filter((p) => !inside(p) || isRule(p)), `${dir}/`]);
  };
  const toggleBuiltin = (on: boolean) =>
    on
      ? save([...patterns, ...named], [], named)
      : save(
          without(named),
          named.filter((p) => patterns.includes(p)),
        );
  const add = () => {
    const pattern = adding
      .trim()
      .replace(/\\/g, "/")
      .replace(/^(!?)\.\//, "$1");
    if (pattern && !patterns.includes(pattern)) save([...patterns, pattern], [], [pattern]);
    setAdding("");
  };

  // Folders start closed unless they hold something hidden; a filter opens every one it shows.
  const filtering = filter.trim() !== "" || hiddenOnly;
  const isOpen = (dir: string) =>
    filtering || (expanded ? expanded.has(dir) : (folders.get(dir)?.hidden ?? 0) > 0);
  const toggleOpen = (dir: string) => {
    const next = new Set(
      expanded ?? [...folders.keys()].filter((d) => (folders.get(d)?.hidden ?? 0) > 0),
    );
    if (!next.delete(dir)) next.add(dir);
    setExpanded(next);
  };
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return files.filter(
      (f) =>
        (!needle || f.toLowerCase().includes(needle)) && (!hiddenOnly || states.get(f)?.hidden),
    );
  }, [files, filter, hiddenOnly, states]);
  const tree = useMemo(() => buildFileTree(shown.map((fileName) => ({ fileName }))), [shown]);

  const why = (s: Hidden) => {
    if (!s.by) return null;
    if (s.by.startsWith("!")) return `visible: ${s.by}`;
    if (named.includes(s.by)) return `named by ${namer(s.by) ?? "a check"}`;
    return isRule(s.by) ? `rule ${s.by}` : "picked";
  };

  const row = (node: FileTreeNode, depth: number): React.ReactNode => {
    const indent = { paddingLeft: `${4 + depth * 14}px` };
    if (node.isDir) {
      const count = folders.get(node.path) ?? { all: 0, hidden: 0 };
      const lock = count.hidden === count.all ? "on" : count.hidden ? "part" : "off";
      const opened = isOpen(node.path);
      return (
        <li key={node.path}>
          <div
            className="group flex items-center gap-1 rounded py-0.5 hover:bg-muted/40"
            style={indent}
          >
            <LockButton
              state={lock}
              locked={locked}
              label={lock === "on" ? `Let the agent see ${node.path}/` : `Hide ${node.path}/`}
              onClick={() => toggleFolder(node.path)}
            />
            <button
              type="button"
              aria-expanded={opened}
              className="flex min-w-0 items-center gap-1"
              onClick={() => toggleOpen(node.path)}
            >
              {opened ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              <span className="truncate">{node.name}/</span>
            </button>
            {count.hidden > 0 && (
              <span className="shrink-0 font-sans text-muted-foreground">
                {count.hidden} of {count.all} hidden
              </span>
            )}
          </div>
          {opened && <ul>{node.children?.map((child) => row(child, depth + 1))}</ul>}
        </li>
      );
    }
    const s = state(node.path);
    const reason = why(s);
    const gap = !s.hidden ? depends.get(node.path) : undefined;
    const dot = node.name.indexOf(".", 1);
    const ext = dot > 0 ? node.name.slice(dot) : "";
    return (
      <li
        key={node.path}
        className="group flex items-center gap-1.5 rounded py-0.5 hover:bg-muted/40"
        style={indent}
      >
        <LockButton
          state={s.hidden ? "on" : "off"}
          locked={locked}
          label={s.hidden ? `Let the agent see ${node.path}` : `Hide ${node.path}`}
          onClick={() => toggleFile(node.path)}
        />
        <span className={cn("truncate", s.hidden && "text-muted-foreground line-through")}>
          {node.name}
        </span>
        {reason && (
          <span className="shrink-0 rounded bg-muted/60 px-1 font-sans text-[10px] text-muted-foreground">
            {reason}
          </span>
        )}
        {gap && (
          <span className="flex shrink-0 items-center gap-1 font-sans text-warning">
            <TriangleAlert className="size-3" />
            {gap}
          </span>
        )}
        {!s.hidden && ext && !locked && !gap && (
          <button
            type="button"
            className="ml-auto shrink-0 font-sans text-accent opacity-0 hover:underline group-hover:opacity-100"
            onClick={() => save([...patterns, `**/*${ext}`])}
          >
            Hide all *{ext}
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-medium">Hidden from the agent</span>
        <span className="min-w-0 truncate text-muted-foreground">
          · {hidden} of {plural(files.length, "file")} hidden ·{" "}
          {plural(rules.length + (builtinOn ? 1 : 0), "rule")}, {picked.length} picked,{" "}
          {plural(exceptions.length, "exception")}
        </span>
        {gaps.length > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-warning">
            <TriangleAlert className="size-3" />
            {gaps.length === 1
              ? "1 file a check depends on is visible"
              : `${gaps.length} files a check depends on are visible`}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3 text-xs">
          <p className="text-muted-foreground">
            The agent works in a copy of the branch without these files, so it cannot read or change
            what judges it. The checks and the steps run with them in place.
          </p>
          {locked && (
            <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-muted-foreground">
              <Lock className="size-3 shrink-0" />
              Fixed once the loop has started. Accepting a proposed check can still hide more.
            </div>
          )}
          <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-3">
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="px-1 font-medium">Rules</div>
                <div className="rounded-md border border-border bg-background p-1">
                  <label className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/40">
                    <Checkbox
                      checked={builtinOn}
                      disabled={locked || named.length === 0}
                      onCheckedChange={toggleBuiltin}
                    />
                    <span className="min-w-0 flex-1 truncate">Files the checks and steps name</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {plural(files.filter((f) => hiddenMatcher(named)(f).hidden).length, "file")}
                    </span>
                  </label>
                  {rules.map((rule) => (
                    <Entry
                      key={rule}
                      text={rule}
                      count={matches(rule, files)}
                      locked={locked}
                      onRemove={() => save(without([rule]))}
                    />
                  ))}
                </div>
                {!locked && (
                  <div className="flex items-center gap-1.5 px-1 pt-1">
                    <Input
                      value={adding}
                      aria-label="Add a pattern"
                      placeholder="Add a pattern: tests/, **/*.spec.ts, !tests/helpers/"
                      onChange={(e) => setAdding(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          add();
                        }
                      }}
                      className="h-7 flex-1 font-mono text-xs"
                    />
                    {adding.trim() && (
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {plural(matches(adding.trim(), files), "file")}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <div className="px-1 font-medium">Picked in the tree</div>
                <div className="rounded-md border border-border bg-background p-1">
                  {picked.length === 0 && (
                    <div className="px-2 py-1 text-muted-foreground">
                      Click the lock of a row in the tree to hide one file or folder.
                    </div>
                  )}
                  {picked.map((path) => (
                    <Entry
                      key={path}
                      text={path}
                      locked={locked}
                      onRemove={() => save(without([path]), [path])}
                    />
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <div className="px-1 font-medium">Visible to the agent anyway</div>
                <div className="rounded-md border border-border bg-background p-1">
                  {exceptions.length === 0 && (
                    <div className="px-2 py-1 text-muted-foreground">
                      Click the lock of a hidden file to let the agent see it.
                    </div>
                  )}
                  {exceptions.map((path) => (
                    <Entry
                      key={path}
                      text={path}
                      locked={locked}
                      onRemove={() => save(without([path]))}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="min-w-0 space-y-1.5">
              <div className="flex items-center gap-2">
                <Input
                  value={filter}
                  aria-label="Filter files"
                  placeholder="Filter files on the loop's branch"
                  onChange={(e) => setFilter(e.target.value)}
                  className="h-7 flex-1 font-mono text-xs"
                />
                <label className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  <Checkbox checked={hiddenOnly} onCheckedChange={setHiddenOnly} />
                  Hidden only
                </label>
              </div>
              <ul className="max-h-[440px] overflow-auto rounded-md border border-border bg-background p-1 font-mono">
                {listed === undefined ? (
                  <li className="px-2 py-1 font-sans text-muted-foreground">Reading the branch…</li>
                ) : tree.length === 0 ? (
                  <li className="px-2 py-1 font-sans text-muted-foreground">No file matches.</li>
                ) : (
                  tree.map((node) => row(node, 0))
                )}
              </ul>
              <div className="px-1 text-muted-foreground">
                Only files on the loop's branch are listed.
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
