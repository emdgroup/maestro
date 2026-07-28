import { describe, it, expect } from "vitest";

import { cn } from "@/lib/utils.ts";
import { shellLang } from "./CommandLabel";

describe("shellLang", () => {
  it("defaults to bash", () => {
    expect(shellLang("git log --oneline | head -50")).toBe("bash");
    expect(shellLang("cargo test --workspace -- --nocapture")).toBe("bash");
    expect(shellLang("ls -la")).toBe("bash");
  });

  it("does not mistake a bash flag or a hyphenated path for a cmdlet", () => {
    expect(shellLang("bun run test --reporter=verbose src/Foo-Bar/x.ts")).toBe("bash");
    expect(shellLang("./scripts/Build-Release.sh")).toBe("bash");
  });

  it("recognises an explicit shell invocation", () => {
    expect(shellLang("pwsh -NoProfile -c 'exit 0'")).toBe("powershell");
    expect(shellLang("powershell.exe -File build.ps1")).toBe("powershell");
  });

  it("recognises cmdlets, $env: and PowerShell-only parameters", () => {
    expect(shellLang("Get-ChildItem -Path src -Recurse")).toBe("powershell");
    expect(shellLang("echo $env:PATH")).toBe("powershell");
    expect(shellLang("Remove-Item build -ErrorAction SilentlyContinue")).toBe("powershell");
  });

  it("finds a cmdlet after a pipe or on a later line", () => {
    expect(shellLang("dir | Select-Object Name")).toBe("powershell");
    expect(shellLang("cd src\nGet-Content main.rs")).toBe("powershell");
  });
});

describe("cn on arbitrary variants", () => {
  // CommandLabel overrides HighlightedCode's own `[&_pre]:…` defaults through
  // this merge; if tailwind-merge ever stopped grouping them both would ship
  // and the winner would be stylesheet order.
  it("lets a later [&_pre]: utility replace an earlier one", () => {
    expect(cn("[&_pre]:p-3", "[&_pre]:p-0")).toBe("[&_pre]:p-0");
    expect(cn("[&_pre]:overflow-x-auto", "[&_pre]:overflow-x-visible")).toBe(
      "[&_pre]:overflow-x-visible",
    );
  });
});
