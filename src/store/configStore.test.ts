import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ToolCheckEntry } from "@/types/bindings";
import { useConfigStore, usePreflightToolChecks } from "./configStore";

const check = (tool: string) => ({ tool, available: true }) as ToolCheckEntry;

describe("configStore – preflight tool checks", () => {
  /** SSH and WSL ids come from different tables, so the same number names two connections. */
  it("keeps an SSH and a WSL connection with the same id apart", () => {
    const { setPreflightToolChecks } = useConfigStore.getState();
    setPreflightToolChecks({ type: "ssh", id: 1 }, [check("git")]);
    setPreflightToolChecks({ type: "wsl", id: 1 }, [check("node")]);

    const ssh = renderHook(() => usePreflightToolChecks({ type: "ssh", id: 1 }));
    const wsl = renderHook(() => usePreflightToolChecks({ type: "wsl", id: 1 }));
    expect(ssh.result.current.map((c) => c.tool)).toEqual(["git"]);
    expect(wsl.result.current.map((c) => c.tool)).toEqual(["node"]);
  });
});
