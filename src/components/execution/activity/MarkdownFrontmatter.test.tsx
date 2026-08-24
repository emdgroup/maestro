import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { splitFrontmatter } from "./MarkdownFrontmatter";
import { MarkdownBlock } from "./MarkdownBlock";

describe("splitFrontmatter", () => {
  it("parses a leading block and returns the body without it", () => {
    const { data, body } = splitFrontmatter("---\nname: skill\nlicense: MIT\n---\n# Title\n");
    expect(data).toEqual({ name: "skill", license: "MIT" });
    expect(body).toBe("# Title\n");
  });

  it("parses a block that is the whole document", () => {
    const { data, body } = splitFrontmatter("---\nname: skill\n---");
    expect(data).toEqual({ name: "skill" });
    expect(body).toBe("");
  });

  it("accepts `...` as the terminator", () => {
    expect(splitFrontmatter("---\nname: skill\n...\nbody").data).toEqual({ name: "skill" });
  });

  it("handles CRLF line endings", () => {
    const { data, body } = splitFrontmatter("---\r\nname: skill\r\n---\r\n# Title");
    expect(data).toEqual({ name: "skill" });
    expect(body).toBe("# Title");
  });

  it("keeps nested mappings and sequences", () => {
    const { data } = splitFrontmatter(
      "---\nmetadata:\n  author: vercel\n  version: 1.0.0\ntags:\n  - react\n  - ui\n---\n",
    );
    expect(data).toEqual({
      metadata: { author: "vercel", version: "1.0.0" },
      tags: ["react", "ui"],
    });
  });

  it("leaves a `---` rule later in the document alone", () => {
    const text = "# Title\n\n---\n\nname: not frontmatter\n";
    expect(splitFrontmatter(text)).toEqual({ data: null, body: text });
  });

  it("leaves an unterminated block alone", () => {
    const text = "---\nname: skill\n";
    expect(splitFrontmatter(text)).toEqual({ data: null, body: text });
  });

  it("leaves a block that is not a mapping alone", () => {
    const text = "---\nSome prose\n---\n";
    expect(splitFrontmatter(text)).toEqual({ data: null, body: text });
  });

  it("leaves an empty block alone", () => {
    for (const text of ["---\n---\n", "---\n\n---\n"]) {
      expect(splitFrontmatter(text)).toEqual({ data: null, body: text });
    }
  });

  it("leaves unparseable YAML alone", () => {
    const text = "---\nname: [unclosed\n---\n";
    expect(splitFrontmatter(text)).toEqual({ data: null, body: text });
  });
});

// Guards the seam the unit tests cannot see: that MarkdownBlock renders the
// table and still renders the body below it as markdown.
describe("MarkdownBlock frontmatter", () => {
  it("renders the block as a table above the body", () => {
    render(<MarkdownBlock text={"---\nname: skill\n---\n# Title\n"} />);
    expect(screen.getByText("name").tagName).toBe("TD");
    expect(screen.getByText("skill")).toBeTruthy();
    expect(screen.getByText("Title").tagName).toBe("H1");
  });

  it("renders a nested mapping as a nested table", () => {
    const { container } = render(
      <MarkdownBlock text={"---\nmetadata:\n  author: vercel\n---\nbody\n"} />,
    );
    expect(container.querySelectorAll("table")).toHaveLength(2);
    expect(screen.getByText("author").tagName).toBe("TD");
    expect(screen.getByText("vercel")).toBeTruthy();
  });

  it("renders a sequence as a list", () => {
    const { container } = render(<MarkdownBlock text={"---\ntags:\n  - react\n  - ui\n---\n"} />);
    const items = container.querySelectorAll("td li");
    expect([...items].map((li) => li.textContent)).toEqual(["react", "ui"]);
  });

  it("leaves a document without frontmatter untouched", () => {
    const { container } = render(<MarkdownBlock text={"# Title\n\n---\n\ntext\n"} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("hr")).not.toBeNull();
  });
});
