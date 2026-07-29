import { describe, expect, it } from "vitest";
import { basename, getFolderName, isAbsolutePath, toPosixPath } from "./path-utils";

describe("toPosixPath", () => {
  it("rewrites the separators a Windows tool call reports", () => {
    expect(toPosixPath("C:\\Users\\me\\repo\\src\\index.css")).toBe(
      "C:/Users/me/repo/src/index.css",
    );
  });

  it("leaves a posix path untouched", () => {
    expect(toPosixPath("/home/me/repo/src/index.css")).toBe("/home/me/repo/src/index.css");
  });
});

describe("isAbsolutePath", () => {
  it("recognises the shapes a file link outside the project arrives in", () => {
    expect(isAbsolutePath("C:\\Users\\me\\.claude\\memory\\MEMORY.md")).toBe(true);
    expect(isAbsolutePath("C:/Users/me/.claude/memory/MEMORY.md")).toBe(true);
    expect(isAbsolutePath("/home/me/.claude/memory/MEMORY.md")).toBe(true);
    expect(isAbsolutePath("\\\\wsl$\\Ubuntu\\home\\me\\notes.md")).toBe(true);
  });

  it("leaves a project-relative path joinable", () => {
    expect(isAbsolutePath("src/components/App.tsx")).toBe(false);
    expect(isAbsolutePath("src\\components\\App.tsx")).toBe(false);
    expect(isAbsolutePath("App.tsx")).toBe(false);
  });
});

describe("basename", () => {
  it("takes the last segment whichever separator is used", () => {
    expect(basename("src\\components\\App.tsx")).toBe("App.tsx");
    expect(basename("src/components/App.tsx")).toBe("App.tsx");
  });

  it("returns a bare filename as-is", () => {
    expect(basename("App.tsx")).toBe("App.tsx");
  });
});

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
