import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, partialMatchKey } from "@tanstack/react-query";
import { useAnnotationStore } from "@/store/annotationStore";

vi.mock("@/lib/tauri-utils", () => ({ api: { cancelAcpSession: vi.fn(async () => {}) } }));

import { executionQueryKeys, useCancelActiveSessionMutation } from "./execution.service";

describe("executionQueryKeys.agentConfig", () => {
  /**
   * The model belongs in the key because the answer depends on it: effort is a per-model setting,
   * so a probe answered against the agent's default model reports the wrong effort list for every
   * profile that named another one. Without this the cache would hand that wrong list back for
   * ever, since the query is `staleTime: Infinity`.
   */
  it("separates two models of the same agent", () => {
    const a = executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex");
    const b = executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-mini");

    expect(a).not.toEqual(b);
  });

  /** Same agent, same cwd, same model is one probe — four profiles must not spawn four sessions. */
  it("is stable for the same agent, directory and model", () => {
    expect(
      executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex"),
    ).toEqual(executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex"));
  });

  /** "No model chosen" is its own entry, not a wildcard sharing whichever model probed last. */
  it("gives an unset model a key of its own", () => {
    expect(executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "")).not.toEqual(
      executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex"),
    );
  });
});

describe("executionQueryKeys.sessionListsOf", () => {
  /** What renaming a session refetches: that agent's history everywhere, nobody else's. */
  it("reaches the agent's lists in every directory and no other agent's", () => {
    const prefix = executionQueryKeys.sessionListsOf("codex");
    const local = { type: "local" } as const;
    expect(partialMatchKey(executionQueryKeys.sessionList("codex", "/a", local), prefix)).toBe(
      true,
    );
    expect(partialMatchKey(executionQueryKeys.sessionList("codex", "/b", local), prefix)).toBe(
      true,
    );
    expect(partialMatchKey(executionQueryKeys.sessionList("claude", "/a", local), prefix)).toBe(
      false,
    );
  });
});

describe("useCancelActiveSessionMutation", () => {
  /** Notes are kept per session id, so a closed session's would otherwise stay in memory for good. */
  it("drops the closed session's annotations", async () => {
    const note = { id: "n1", kind: "plan", quote: "q", occurrence: 0, text: "t" } as const;
    useAnnotationStore.getState().addAnnotation("s1", note);
    useAnnotationStore.getState().addAnnotation("s2", { ...note, id: "n2" });
    const client = new QueryClient();
    const { result } = renderHook(() => useCancelActiveSessionMutation(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    await act(() => result.current.mutateAsync({ sessionId: "s1", executionMode: "acp" }));

    expect(useAnnotationStore.getState().bySession.s1).toBeUndefined();
    expect(useAnnotationStore.getState().bySession.s2).toHaveLength(1);
  });
});
