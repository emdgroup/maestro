export type ToolStats = {
  reads?: number;
  searches?: number;
  bash?: number;
  edits?: number;
};

export type GitOperation = {
  commitSha?: string;
  pushBranch?: string;
  prNumber?: number;
  prUrl?: string;
  prAction?: string;
  branchAction?: string;
  branchRef?: string;
};

export type AgentMeta = {
  parentToolCallId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  /** The agent's own tool name (Read, Write, Bash…) — finer than the ACP `kind`. */
  toolName?: string;
  /** Why the call was made, when the agent supplies one alongside the command. */
  description?: string;
  /** Tool output when the payload carried no `content[]` to render. */
  output?: string;
  /** The file a read or write acted on, for opening it from the row. */
  filePath?: string;
  /** The short reason a call failed or was refused. */
  errorText?: string;
  /** Refused by policy rather than crashed — a different thing to tell the user. */
  blocked?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  fileTotalLines?: number;
  fileStartLine?: number;
  fileNumLines?: number;
  matchFileCount?: number;
  /** What a content search looked for, and where — its title is a mangled command. */
  searchPattern?: string;
  searchScope?: string;
  agentType?: string;
  model?: string;
  outputTokens?: number;
  cachedTokens?: number;
  toolStats?: ToolStats;
  git?: GitOperation;
};

type AgentMetaExtractor = (raw: Record<string, unknown>) => AgentMeta;

/** ACP kinds that act on exactly one file. */
const FILE_KINDS = new Set([
  "read",
  "read_file",
  "edit",
  "edit_file",
  "write_file",
  "create_file",
  "delete",
  "move",
]);

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Text carried by an ACP content block or a rawOutput entry, whatever shape it took. */
function blockText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  const o = obj(v);
  if (!o) return undefined;
  return str(o.text) ?? blockText(o.content);
}

function joinText(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() ? v : undefined;
  if (Array.isArray(v)) {
    const parts = v.map(blockText).filter((t): t is string => t != null);
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

function extractClaudeCodeMeta(raw: Record<string, unknown>): AgentMeta {
  const cc = obj(obj(raw._meta)?.claudeCode);
  if (!cc) return {};

  const result: AgentMeta = {};

  result.parentToolCallId = str(cc.parentToolUseId);
  result.toolName = str(cc.toolName);
  // Both automode-blocked and permission-rule mean "never ran", not "crashed".
  if (str(cc.nonExecutionKind)) result.blocked = true;

  const tr = obj(cc.toolResponse);
  if (!tr) return result;

  // A refusal reaches us two ways — the marker above, or a reason with no marker.
  if (str(tr.decisionReason)) result.blocked = true;

  result.totalDurationMs = num(tr.totalDurationMs);
  result.totalTokens = num(tr.totalTokens);
  result.totalToolUseCount = num(tr.totalToolUseCount);
  result.agentType = str(tr.agentType);
  result.model = str(tr.resolvedModel);

  // The classifier's reason is the readable half of `message`, which wraps it in boilerplate.
  result.errorText = str(tr.decisionReason) ?? str(tr.stderr) ?? str(tr.message);

  const file = obj(tr.file);
  if (file) {
    result.fileTotalLines = num(file.totalLines);
    result.fileStartLine = num(file.startLine);
    result.fileNumLines = num(file.numLines);
  }
  result.filePath = str(tr.filePath) ?? str(file?.filePath);

  const patch = tr.structuredPatch;
  if (Array.isArray(patch)) {
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
      const lines = obj(hunk)?.lines;
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    }
    if (added || removed) {
      result.linesAdded = added;
      result.linesRemoved = removed;
    }
  }

  result.matchFileCount =
    num(tr.numFiles) ?? (Array.isArray(tr.filenames) ? tr.filenames.length : undefined);

  const usage = obj(tr.usage);
  if (usage) {
    result.outputTokens = num(usage.output_tokens);
    result.cachedTokens = num(usage.cache_read_input_tokens);
  }

  const stats = obj(tr.toolStats);
  if (stats) {
    result.toolStats = {
      reads: num(stats.readCount),
      searches: num(stats.searchCount),
      bash: num(stats.bashCount),
      edits: num(stats.editFileCount),
    };
  }

  const git = obj(tr.gitOperation);
  if (git) {
    const commit = obj(git.commit);
    const push = obj(git.push);
    const pr = obj(git.pr);
    const branch = obj(git.branch);
    result.git = {
      commitSha: str(commit?.sha),
      pushBranch: str(push?.branch),
      prNumber: num(pr?.number),
      prUrl: str(pr?.url),
      prAction: str(pr?.action),
      branchAction: str(branch?.action),
      branchRef: str(branch?.ref),
    };
  }

  return result;
}

/**
 * Vendor-neutral fallback: everything derivable from the ACP payload itself, so
 * an agent that sends no `_meta` still gets its output, an intent line and edit
 * counts. Runs last, so a vendor extractor's richer value always wins.
 */
function extractGenericMeta(raw: Record<string, unknown>): AgentMeta {
  const result: AgentMeta = {};

  // Any vendor namespace under _meta that names its tool — not just claudeCode.
  const meta = obj(raw._meta);
  if (meta) {
    for (const value of Object.values(meta)) {
      const name = str(obj(value)?.toolName);
      if (name) {
        result.toolName = name;
        break;
      }
    }
  }

  result.description = str(obj(raw.rawInput)?.description);

  // ACP puts the file on `locations`; agents that skip it still send an input path.
  // Gated on kind: a search also reports locations, but those are matches, not the
  // one file the call acted on.
  if (FILE_KINDS.has(String(raw.kind))) {
    const firstLocation = Array.isArray(raw.locations) ? obj(raw.locations[0]) : undefined;
    result.filePath = str(obj(raw.rawInput)?.file_path) ?? str(firstLocation?.path);
  }

  const content = Array.isArray(raw.content) ? raw.content : [];

  // Only when nothing renders from content[] — otherwise this duplicates whole
  // file bodies into the store for no visible gain.
  if (content.length === 0) result.output = joinText(raw.rawOutput);

  // An ACP diff block carries the replaced fragment, so its two sides are the
  // added and removed line counts for that edit.
  let added = 0;
  let removed = 0;
  for (const block of content) {
    const b = obj(block);
    if (b?.type !== "diff") continue;
    if (typeof b.newText === "string") added += b.newText.split("\n").length;
    if (typeof b.oldText === "string") removed += b.oldText.split("\n").length;
  }
  if (added || removed) {
    result.linesAdded = added;
    result.linesRemoved = removed;
  }

  if (raw.kind === "search" && Array.isArray(raw.locations) && raw.locations.length > 0) {
    result.matchFileCount = raw.locations.length;
  }

  if (raw.kind === "search") {
    const input = obj(raw.rawInput);
    const pattern = str(input?.pattern) ?? str(input?.query);
    // A scope is what separates a content search from a search for a *file name*,
    // whose title ("Find `.maestro/state.json`") is already the pattern and reads
    // better than anything rebuilt from it.
    const scope = str(input?.glob) ?? str(input?.path);
    if (pattern && (scope || input?.output_mode != null)) {
      result.searchPattern = pattern;
      if (scope) result.searchScope = shortenScope(scope);
    }
  }

  return result;
}

/**
 * Search paths arrive absolute, which is most of a row's width spent on the part
 * every row shares. Two trailing segments locate it well enough to read.
 */
function shortenScope(scope: string): string {
  const segments = scope.split(/[\\/]/).filter(Boolean);
  return segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : segments.join("/");
}

// Add new agent extractors here — one function per agent format.
// Each extractor receives the raw event payload and returns whatever fields it can populate.
// Fields from earlier extractors take precedence over later ones, so the generic
// fallback stays last.
const AGENT_META_EXTRACTORS: AgentMetaExtractor[] = [extractClaudeCodeMeta, extractGenericMeta];

export function extractAgentMeta(raw: Record<string, unknown>): AgentMeta {
  const result: AgentMeta = {};
  for (const extract of AGENT_META_EXTRACTORS) {
    mergeAgentMeta(result, extract(raw));
  }
  return result;
}

/**
 * Copies only the keys the source actually carries. Tool calls arrive as a create
 * frame plus n updates, each a partial view — a plain spread would let a later
 * frame blank a field an earlier one supplied.
 */
export function mergeAgentMeta(target: AgentMeta, source: AgentMeta): AgentMeta {
  for (const key of Object.keys(source) as (keyof AgentMeta)[]) {
    if (source[key] !== undefined && target[key] === undefined) {
      (target as Record<string, unknown>)[key] = source[key];
    }
  }
  return target;
}
