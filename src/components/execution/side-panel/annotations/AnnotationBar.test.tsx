import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AnnotationBar } from "./AnnotationBar";
import { useAnnotationStore } from "@/store/annotationStore";
import type { Annotation } from "@/store/annotationStore";

const SESSION = 7;

function diff(id: string, line: number, text: string): Annotation {
  return { id, kind: "diff", filePath: "src/git/merge.rs", lineNumber: line, side: "new", text };
}

function plan(id: string, text: string): Annotation {
  return { id, kind: "plan", quote: "guarded", occurrence: 0, text };
}

function add(...annotations: Annotation[]) {
  act(() => {
    for (const a of annotations) useAnnotationStore.getState().addAnnotation(SESSION, a);
  });
}

describe("AnnotationBar", () => {
  beforeEach(() => {
    act(() => useAnnotationStore.getState().clearSession(SESSION));
  });

  it("stays hidden until the first annotation of its own kind exists", () => {
    const { container } = render(
      <AnnotationBar sessionKey={SESSION} kind="diff" onSend={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();

    // A plan annotation must not raise the diff tab's bar — the two counts are independent.
    add(plan("p1", "which value?"));
    expect(container).toBeEmptyDOMElement();

    add(diff("d1", 42, "leaks"));
    expect(screen.getByText("Send annotations")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("sends every annotation of its kind and reports the count", () => {
    const onSend = vi.fn();
    render(<AnnotationBar sessionKey={SESSION} kind="diff" onSend={onSend} />);
    add(diff("d1", 42, "leaks"), diff("d2", 7, "why unwrap"), plan("p1", "which value?"));

    expect(screen.getByText("2")).toBeTruthy();
    act(() => screen.getByText("Send annotations").click());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].map((a: Annotation) => a.id)).toEqual(["d1", "d2"]);
  });

  it("does not send while the agent is busy", () => {
    const onSend = vi.fn();
    render(<AnnotationBar sessionKey={SESSION} kind="diff" onSend={onSend} sendDisabled />);
    add(diff("d1", 42, "leaks"));

    act(() => screen.getByText("Send annotations").click());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("reports the annotation a list row points at, and keeps the list open", () => {
    const onGoTo = vi.fn();
    render(<AnnotationBar sessionKey={SESSION} kind="diff" onSend={vi.fn()} onGoTo={onGoTo} />);
    add(diff("d1", 42, "leaks"), diff("d2", 7, "why unwrap"));

    act(() => screen.getByText("2").click());
    act(() => screen.getByText("why unwrap").click());

    expect(onGoTo).toHaveBeenCalledWith("d2");
    // Navigating is not a dismissal — the other rows are still there to step through.
    expect(screen.getByText("leaks")).toBeTruthy();
  });

  it("leaves the list inert for hosts with nowhere to navigate to", () => {
    render(<AnnotationBar sessionKey={SESSION} kind="diff" onSend={vi.fn()} />);
    add(diff("d1", 42, "leaks"), diff("d2", 7, "why unwrap"));

    act(() => screen.getByText("2").click());

    expect(screen.queryByTitle("Next annotation")).toBeNull();
    expect(screen.queryByTitle("Previous annotation")).toBeNull();
  });
});
