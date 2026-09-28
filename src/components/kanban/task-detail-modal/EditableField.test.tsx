import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditableField } from "./EditableField";

vi.mock("@/store/projectStore", () => ({ useSelectedProject: () => null }));

describe("EditableField (single line)", () => {
  it("shows a value set from outside after mount", () => {
    const { rerender } = render(<EditableField value="" onSave={() => {}} isEditable />);
    rerender(<EditableField value="Imported title" onSave={() => {}} isEditable />);
    expect(screen.getByRole("textbox")).toHaveValue("Imported title");
  });

  it("saves the edited text on blur", async () => {
    const onSave = vi.fn();
    render(<EditableField value="Old" onSave={onSave} isEditable />);
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "New");
    await userEvent.tab();
    expect(onSave).toHaveBeenCalledWith("New");
  });
});
