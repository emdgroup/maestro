import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/tauri-utils", () => ({ api: { createFileAt: vi.fn(async () => {}) } }));

import { connectionQueryKeys, useCreateFile } from "./connection.service";

describe("useCreateFile", () => {
  /** The tree filters on the workspace index, so a new file has to reach it as well as the folder. */
  it("refreshes the connection's listings and its workspace index", async () => {
    const local = { type: "local" } as const;
    const client = new QueryClient();
    const dir = connectionQueryKeys.dirContents(local, "/repo", false);
    const index = connectionQueryKeys.workspaceFiles(local, "/repo", false);
    const elsewhere = connectionQueryKeys.workspaceFiles({ type: "wsl", id: 1 }, "/repo", false);
    for (const key of [dir, index, elsewhere]) client.setQueryData(key, []);
    const { result } = renderHook(() => useCreateFile(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    await act(() => result.current.mutateAsync({ connection: local, path: "/repo/a.ts" }));

    const invalidated = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated ?? false;
    expect(invalidated(dir)).toBe(true);
    expect(invalidated(index)).toBe(true);
    expect(invalidated(elsewhere)).toBe(false);
  });
});
