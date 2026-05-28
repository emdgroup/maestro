export type AgentMeta = {
  parentToolCallId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
};

type AgentMetaExtractor = (raw: Record<string, unknown>) => AgentMeta;

function extractClaudeCodeMeta(raw: Record<string, unknown>): AgentMeta {
  const meta = raw._meta;
  if (meta == null || typeof meta !== "object") return {};
  const cc = (meta as Record<string, unknown>).claudeCode;
  if (cc == null || typeof cc !== "object") return {};

  const result: AgentMeta = {};

  const parentId = (cc as Record<string, unknown>).parentToolUseId;
  if (typeof parentId === "string") result.parentToolCallId = parentId;

  const tr = (cc as Record<string, unknown>).toolResponse;
  if (tr != null && typeof tr === "object") {
    const trObj = tr as Record<string, unknown>;
    if (typeof trObj.totalDurationMs === "number") result.totalDurationMs = trObj.totalDurationMs;
    if (typeof trObj.totalTokens === "number") result.totalTokens = trObj.totalTokens;
    if (typeof trObj.totalToolUseCount === "number")
      result.totalToolUseCount = trObj.totalToolUseCount;
  }

  return result;
}

// Add new agent extractors here — one function per agent format.
// Each extractor receives the raw event payload and returns whatever fields it can populate.
// Fields from earlier extractors take precedence over later ones.
const AGENT_META_EXTRACTORS: AgentMetaExtractor[] = [
  extractClaudeCodeMeta,
  // extractCodexMeta,
];

export function extractAgentMeta(raw: Record<string, unknown>): AgentMeta {
  const result: AgentMeta = {};
  for (const extract of AGENT_META_EXTRACTORS) {
    const partial = extract(raw);
    for (const key of Object.keys(partial) as (keyof AgentMeta)[]) {
      if (result[key] === undefined) {
        (result as Record<string, unknown>)[key] = partial[key];
      }
    }
  }
  return result;
}
