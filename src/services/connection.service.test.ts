import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/tauri-utils", () => ({
  api: { createFileAt: vi.fn(async () => {}), connectSshWithoutCredentials: vi.fn() },
}));

import { api } from "@/lib/tauri-utils";
import { connectionKeyStr } from "@/lib/connection-utils";
import { useHomeStore } from "@/store/homeStore";
import { connect, connectionQueryKeys, useCreateFile } from "./connection.service";

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

describe("connect", () => {
  const ssh = { type: "ssh", id: 7 } as const;
  const rejectWith = (message: string) =>
    vi.mocked(api.connectSshWithoutCredentials).mockRejectedValueOnce(new Error(message));

  /** A changed host key is not a sign-in problem: asking for a password would hide it. */
  it("shows a host key mismatch as a failure, not the sign-in form", async () => {
    const error = "host_key_changed: The host key of example.com:22 changed.";
    rejectWith(error);

    await connect(ssh);

    expect(useHomeStore.getState().phases[connectionKeyStr(ssh)]).toEqual({
      kind: "failed",
      error,
      result: null,
    });
  });

  it("falls back to the sign-in form on any other error", async () => {
    rejectWith("SSH connection failed: SSH Authentication Error: no password");

    await connect(ssh);

    expect(useHomeStore.getState().phases[connectionKeyStr(ssh)]).toEqual({
      kind: "signin",
      error: null,
    });
  });
});
