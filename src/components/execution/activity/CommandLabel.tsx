import { HighlightedCode } from "./HighlightedCode";

/**
 * Which shell grammar to colour a command with.
 *
 * ACP never says which shell ran it, and the project's connection type is four
 * props above a stream row — so this guesses from the text. Bash is the default
 * because it is what a wrong guess degrades to most gracefully: PowerShell read
 * as bash still colours strings, pipes and operators.
 */
export function shellLang(command: string): "powershell" | "bash" {
  const powershell =
    // an invocation of the shell itself
    /(^|[|;&(]\s*)(pwsh|powershell)(\.exe)?\b/.test(command) ||
    // $env:PATH — no bash equivalent
    /\$env:/i.test(command) ||
    // a Verb-Noun cmdlet at the start of a line or after a pipe
    /(^|[\n|;])\s*[A-Z][a-z]+-[A-Z][A-Za-z]+\b/.test(command) ||
    // PowerShell-only parameters that a bash command would never carry
    /\s-(ErrorAction|ExecutionPolicy|NoProfile|Recurse)\b/.test(command);
  return powershell ? "powershell" : "bash";
}

/**
 * The command line itself, syntax-coloured and frameless — it replaces the plain
 * truncated label when a command row is expanded, so the command is shown once
 * rather than as a label plus a repeat of the same string in a box below.
 *
 * Wraps instead of scrolling: a horizontal scrollbar inside a vertically
 * scrolling stream is only reachable once you have scrolled past it.
 */
export function CommandLabel({ command }: { command: string }) {
  return (
    <HighlightedCode
      code={command}
      lang={shellLang(command)}
      stripContainerStyle
      className="min-w-0 flex-1 text-[11px] [&_pre]:overflow-x-visible [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:leading-relaxed [&_pre]:break-words [&_pre]:whitespace-pre-wrap"
    />
  );
}
