import { describe, expect, it } from "vitest";
import { getFolderName } from "./path-utils";

describe("getFolderName", () => {
  it("returns last segment of a Unix path", () => {
    expect(getFolderName("/home/user/projects/my-app")).toBe("my-app");
  });

  it("strips trailing slash before extracting name", () => {
    expect(getFolderName("/path/to/")).toBe("to");
  });

  it("returns single segment path as-is", () => {
    expect(getFolderName("/home")).toBe("home");
  });

  it("returns original string for root /", () => {
    expect(getFolderName("/")).toBe("/");
  });

  it("works with Windows-style paths", () => {
    expect(getFolderName("C:/Users/foo/my-project")).toBe("my-project");
  });

  it("returns the name for a single filename without directory", () => {
    expect(getFolderName("myfile.txt")).toBe("myfile.txt");
  });

  it("handles path with multiple trailing slashes", () => {
    // filter(Boolean) strips both empty parts
    expect(getFolderName("/a/b//")).toBe("b");
  });
});
