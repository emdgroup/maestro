import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AppErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 p-8 bg-background text-foreground">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground max-w-md text-center">
          An unexpected error occurred. Try reloading the application.
        </p>
        <details className="max-w-lg text-xs text-muted-foreground mt-2">
          <summary className="cursor-pointer hover:text-foreground">Error details</summary>
          <pre className="mt-2 p-3 bg-muted rounded-md overflow-auto max-h-40 whitespace-pre-wrap">
            {this.state.error?.message}
            {"\n"}
            {this.state.error?.stack}
          </pre>
        </details>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          Reload
        </button>
      </div>
    );
  }
}
