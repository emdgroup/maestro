import { describe, expect, it } from "vitest";
import type { UsageTurn } from "@/types/bindings";
import { tokensOf } from "./SessionUsageMeters";

const turn = (t: Partial<UsageTurn>): UsageTurn => ({
  model_id: null,
  started_at: "2026-10-12T09:00:00Z",
  ended_at: "2026-10-12T09:01:00Z",
  total_tokens: null,
  input_tokens: null,
  output_tokens: null,
  thought_tokens: null,
  cached_read_tokens: null,
  cached_write_tokens: null,
  ...t,
});

describe("tokensOf", () => {
  it("keeps input as reported when the total counts the cache separately", () => {
    // Claude: total is every kind added up.
    const t = turn({
      total_tokens: 85013,
      input_tokens: 6,
      output_tokens: 1486,
      cached_read_tokens: 81204,
      cached_write_tokens: 2317,
    });
    expect(tokensOf(t)).toEqual({
      cacheRead: 81204,
      cacheWrite: 2317,
      input: 6,
      thought: 0,
      output: 1486,
    });
  });

  it("takes cache reads out of an input that already counts them", () => {
    // Codex: input includes cached tokens, and the total is input plus output.
    const t = turn({
      total_tokens: 55314,
      input_tokens: 52410,
      output_tokens: 2904,
      thought_tokens: 1152,
      cached_read_tokens: 48128,
    });
    expect(tokensOf(t).input).toBe(52410 - 48128);
  });
});
