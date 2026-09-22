import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ElicitationPrompt } from "./ElicitationPrompt";
import type { ElicitationField } from "./elicitation-utils";

const otherField = { key: "customAnswer", title: "Other" };

function renderPrompt(field: ElicitationField) {
  const onSubmit = vi.fn();
  render(
    <ElicitationPrompt
      requestId="r1"
      message="Pick one"
      fields={[field]}
      otherField={otherField}
      onSubmit={onSubmit}
      onDecline={vi.fn()}
    />,
  );
  return onSubmit;
}

describe("ElicitationPrompt Other option", () => {
  it("replaces the radio pick — one of them is the answer, never both", () => {
    const onSubmit = renderPrompt({
      key: "choice",
      type: "string",
      oneOf: [
        { const: "a", title: "Alpha" },
        { const: "b", title: "Beta" },
      ],
    });

    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByText("Other"));
    fireEvent.change(screen.getByPlaceholderText("Type here…"), {
      target: { value: "gamma" },
    });
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith("r1", { choice: "gamma" });
  });

  it("drops the Other text again once a listed option is picked back", () => {
    const onSubmit = renderPrompt({
      key: "choice",
      type: "string",
      enumValues: ["a", "b"],
    });

    fireEvent.click(screen.getByText("Other"));
    fireEvent.change(screen.getByPlaceholderText("Type here…"), {
      target: { value: "gamma" },
    });
    fireEvent.click(screen.getByText("b"));
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith("r1", { choice: "b" });
  });

  it("adds to the ticked checkboxes rather than replacing them", () => {
    const onSubmit = renderPrompt({
      key: "picks",
      type: "array",
      items: { enum: ["a", "b"] },
    });

    fireEvent.click(screen.getByText("a"));
    fireEvent.click(screen.getByText("Other"));
    fireEvent.change(screen.getByPlaceholderText("Type here…"), {
      target: { value: "c" },
    });
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith("r1", { picks: ["a", "c"] });
  });

  it("picks Other when the user types straight into the box", () => {
    const onSubmit = renderPrompt({
      key: "choice",
      type: "string",
      enumValues: ["a", "b"],
    });

    fireEvent.click(screen.getByText("a"));
    fireEvent.change(screen.getByPlaceholderText("Type here…"), {
      target: { value: "gamma" },
    });
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith("r1", { choice: "gamma" });
  });

  // The box keeps DOM focus while another option is picked, so a re-fired focus handler would
  // silently drag the answer back to Other.
  it("lets a radio option win back a focused Other box", () => {
    const onSubmit = renderPrompt({
      key: "choice",
      type: "string",
      enumValues: ["a", "b"],
    });

    const box = screen.getByPlaceholderText("Type here…");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "gamma" } });
    fireEvent.click(screen.getByText("b"));
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith("r1", { choice: "b" });
  });

  it("counts a checked but empty Other as unanswered on a single select", () => {
    const onSubmit = renderPrompt({
      key: "choice",
      type: "string",
      enumValues: ["a"],
    });

    fireEvent.click(screen.getByText("Other"));
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("1 unanswered, click again")).toBeTruthy();
  });
});
