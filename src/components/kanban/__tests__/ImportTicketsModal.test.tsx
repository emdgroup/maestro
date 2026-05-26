import { describe, it, expect, vi } from "vitest";
import type { Task, RemoteIssue } from "@/types/bindings";
import { classifyIssues } from "../ImportTicketsModal";

vi.mock("@/services/task.service", () => ({
  useFetchRemoteIssuesQuery: vi.fn().mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useImportTasksMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateTaskFromRemoteMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
  useDismissTaskChangeMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
  useTasksQuery: vi.fn().mockReturnValue({ data: [], isLoading: false }),
  useProjectBranchesQuery: vi.fn().mockReturnValue({ data: [[], "main"] }),
}));

vi.mock("@/services/integration.service", () => ({
  useProjectIssueTrackingConfig: vi.fn().mockReturnValue({ data: null }),
  PROVIDER_NAMES: { github: "GitHub" },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

describe("ImportTicketsModal", () => {
  it.todo("IMPT-02: renders 3 tabs: Available, Imported, Changed");
  it.todo("IMPT-02: tab switching changes active tab");
  it.todo("IMPT-04: refetchInterval is 5*60*1000 when modal is open");
  it.todo("IMPT-04: refetchInterval is false when modal is closed");
  it.todo("IMPT-05: Refresh button calls refetch()");
  it.todo("IMPT-06: label filter hides rows that don't match selected label");
  it.todo("CHNG-02: Update task button calls updateTaskFromRemote mutation");
  it.todo("CHNG-02: Dismiss change button calls dismissTaskChange mutation");
});

describe("classifyIssues", () => {
  it("CHNG-01: issue classified as Changed when remote updated_at differs from task external_updated_at", () => {
    const tasks: Task[] = [
      {
        id: 1,
        project_id: 1,
        title: "Fix bug",
        description: "",
        status: "Backlog",
        priority: "None",
        base_branch: "main",
        skills: [],
        labels: [],
        is_imported: true,
        external_id: "github:42",
        external_updated_at: "2024-01-01T00:00:00Z",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        auto_approve: false,
        isolated_worktree: true,
      } as Task,
    ];
    const remoteIssues: RemoteIssue[] = [
      {
        external_id: "github:42",
        title: "Fix bug",
        body: null,
        url: "https://github.com/example/repo/issues/42",
        labels: [],
        updated_at: "2024-06-01T00:00:00Z",
        priority: null,
      },
    ];

    const { changedTasks } = classifyIssues(tasks, remoteIssues);

    expect(changedTasks.length).toBe(1);
    expect(changedTasks[0].external_id).toBe("github:42");
  });

  it("CHNG-01: issue NOT classified as Changed when remote updated_at matches task external_updated_at", () => {
    const sameTimestamp = "2024-06-01T00:00:00Z";
    const tasks: Task[] = [
      {
        id: 1,
        project_id: 1,
        title: "Fix bug",
        description: "",
        status: "Backlog",
        priority: "None",
        base_branch: "main",
        skills: [],
        labels: [],
        is_imported: true,
        external_id: "github:42",
        external_updated_at: sameTimestamp,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        auto_approve: false,
        isolated_worktree: true,
      } as Task,
    ];
    const remoteIssues: RemoteIssue[] = [
      {
        external_id: "github:42",
        title: "Fix bug",
        body: null,
        url: "https://github.com/example/repo/issues/42",
        labels: [],
        updated_at: sameTimestamp,
        priority: null,
      },
    ];

    const { changedTasks } = classifyIssues(tasks, remoteIssues);

    expect(changedTasks.length).toBe(0);
  });

  it("classifies non-imported issues as available", () => {
    const tasks: Task[] = [];
    const remoteIssues: RemoteIssue[] = [
      {
        external_id: "github:1",
        title: "New issue",
        body: null,
        url: "https://github.com/example/repo/issues/1",
        labels: [],
        updated_at: null,
        priority: null,
      },
    ];

    const { available, importedTasks, changedTasks } = classifyIssues(tasks, remoteIssues);

    expect(available.length).toBe(1);
    expect(importedTasks.length).toBe(0);
    expect(changedTasks.length).toBe(0);
  });
});
