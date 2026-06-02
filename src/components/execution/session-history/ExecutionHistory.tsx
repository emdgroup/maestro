interface ExecutionHistoryProps {
  taskId: number;
  projectId: number;
  projectPath: string;
  taskName?: string;
}

// Execution logs were removed in schema V13 (ephemeral sessions).
// This component is kept as a stub so TaskDetail.tsx can still import it.
export function ExecutionHistory(_props: ExecutionHistoryProps) {
  return null;
}
