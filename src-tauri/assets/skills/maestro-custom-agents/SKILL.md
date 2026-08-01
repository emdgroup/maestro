---
name: maestro-custom-agents
description: Add an agent to the Maestro desktop app's picker that its bundled registry does not ship — a local or hosted model reached through an Anthropic-compatible gateway, an in-house ACP adapter, or a second profile of a listed agent with different environment variables. Writes ~/.maestro/custom-agents.json.
disable-model-invocation: true
---

# Adding a custom agent to Maestro

The user ran `/maestro-custom-agents`. Anything they typed after it describes the agent they want
added — use it to skip whichever question below it already answers.

Maestro's agent picker is filled from a registry bundled inside the app. It is deliberately fixed:
its entries decide which executable gets spawned, so it is reviewed as a supply-chain surface and
updated by release. The escape hatch is `~/.maestro/custom-agents.json`, a file the user owns, read
fresh every time Maestro lists agents. Anything expressible as "run this command with these
arguments and these environment variables, speaking ACP on stdio" belongs there.

## You are already on the right machine

The file goes at `~/.maestro/custom-agents.json` — `%USERPROFILE%\.maestro\` on Windows. You are
running inside the Maestro session, which runs where the agent will be spawned, so `~` is already
the correct home. **Never ask the user which machine, host, connection or environment this is for.**

Everything below is likewise something to find out rather than ask:

| Don't ask                  | Do instead                                          |
| -------------------------- | --------------------------------------------------- |
| `id`                       | derive from the name: lowercase, hyphenated, stable |
| `icon`                     | omit it, or reuse the registry's URL in branch 3    |
| binary platform key        | `uname -sm`                                         |
| whether the file exists    | read it                                             |
| whether to pin a version   | always pin                                          |
| whether a command is there | `command -v <cmd>`                                  |

## Ask what kind of agent, then branch

One `AskUserQuestion` with a single question — "What are you adding?" — and these three options:

- **Anthropic-compatible gateway** — a local or hosted endpoint serving the Messages API
- **Custom ACP adapter** — a command not in the registry
- **Second profile of a registry agent** — a listed agent with different environment or arguments

Then follow only the matching branch.

### Branch 1 — Anthropic-compatible gateway

Every gateway below is reached through the same adapter, `claude-acp`, because it is the one that
honours `ANTHROPIC_BASE_URL`. It is an npx package, so nothing needs installing ahead of time —
but `npx` itself must exist. Run `command -v npx` first; if it is missing, say so and stop rather
than writing an entry that cannot spawn.

Ask which gateway with a second `AskUserQuestion` — Ollama, LM Studio, OpenRouter, LiteLLM — and
let the user type anything else in the free-form option.

| Gateway           | `ANTHROPIC_BASE_URL`                                                 | `ANTHROPIC_AUTH_TOKEN`                                 |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| Ollama ≥ 0.14.0   | `http://localhost:11434`                                             | `ollama` — a placeholder it ignores                    |
| LM Studio ≥ 0.4.1 | `http://localhost:1234`                                              | `lmstudio` — only read if Require Authentication is on |
| OpenRouter        | `https://openrouter.ai/api` (not `/api/v1`)                          | their real OpenRouter key                              |
| LiteLLM           | the proxy root, typically `http://localhost:4000` (not `/anthropic`) | a virtual key, or the master key                       |

These are starting points to confirm, not facts about the user's setup — a gateway on another
host or port only changes the URL. Probe before writing: `curl -sf <base-url>/v1/models`. If it
fails, report it and ask for the real URL rather than writing a guess.

For anything the user names in the free-form option, look up its Anthropic-compatible base URL and
whether it needs a key. If it turns out to serve only the OpenAI format, `ANTHROPIC_BASE_URL` will
not work against it — say so instead of writing an entry that returns 400s.

Two more things to settle, both in one `AskUserQuestion`, skipping any the user already answered:

- **The key**: written into this plain-text file, or left out and inherited from the environment
  Maestro was launched from. Their call, not yours — see [Secrets](#secrets).
- **The model**: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` makes the adapter ask the endpoint
  which models it serves and fills Maestro's model selector with them; `ANTHROPIC_MODEL` pins one
  instead. Default to discovery. If the selector later comes up empty — LiteLLM does not yet return
  `/v1/models` in Anthropic's format — pinning `ANTHROPIC_MODEL` is the fallback.

Take the `claude-acp` package version from the live registry rather than hardcoding it:

```bash
curl -s https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

The result, for Ollama with a key left in the file:

```json
{
  "agents": [
    {
      "id": "ollama-claude-acp",
      "name": "Claude Code (Ollama)",
      "distribution": {
        "npx": {
          "package": "@agentclientprotocol/claude-agent-acp@0.64.0",
          "env": {
            "ANTHROPIC_BASE_URL": "http://localhost:11434",
            "ANTHROPIC_AUTH_TOKEN": "ollama",
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
          }
        }
      }
    }
  ]
}
```

### Branch 2 — custom ACP adapter

No question tool here; show the shape and let the user fill it in. Print the template and ask for
the blanks:

```json
{
  "agents": [
    {
      "id": "my-adapter",
      "name": "My Adapter",
      "distribution": { "npx": { "package": "pkg@1.2.3", "args": [], "env": {} } }
    }
  ]
}
```

Swap the `distribution` value for the one matching their launcher:

| Launcher | `distribution`                                                          |
| -------- | ----------------------------------------------------------------------- |
| npx      | `{ "npx": { "package": "pkg@1.2.3", "args": [], "env": {} } }`          |
| uvx      | `{ "uvx": { "package": "pkg==1.2.3", "args": [] } }`                    |
| binary   | `{ "binary": { "linux-x86_64": { "cmd": "my-adapter", "args": [] } } }` |

**`env` is only honoured under `npx`.** Under `uvx` and `binary` it is parsed and then dropped, so
an adapter needing environment variables either goes through `npx` or gets them from a wrapper
script named as `cmd`. Do not write an `env` block under the other two — it will silently do
nothing.

For `binary`, `cmd` must already be on `PATH` or be an absolute path. The `archive` field that
appears in bundled entries is never downloaded; Maestro does not install anything for you.

Verify what they give you before writing: `command -v <cmd>` for a binary, `npm view <pkg> version`
for an npx package.

### Branch 3 — second profile of a registry agent

No question tool here either — there are ~38 registry agents, too many for options. Ask which one
by name, then fetch the registry and pull their entry out:

```bash
curl -s https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

Show them the matching object verbatim and ask what should differ — usually an added `env` block,
sometimes extra `args`. Then:

- **Change the `id`.** An id colliding with a bundled agent is rejected and logged, and the entry
  never appears. Suffix the original, e.g. `claude-acp` becomes `claude-acp-staging`.
- Give it a distinct `name` too, or the picker shows two identical rows.
- Keep the registry's pinned `package` version and its `icon` URL.
- Re-read the `env` caveat in branch 2 — a registry agent distributed as a binary cannot take
  environment variables from this file.

If the fetch fails — no network on this machine — ask the user to paste the entry or name the
package, rather than inventing one.

## The entry

`id`, `name` and `distribution` are required; everything else is optional. `distribution` holds
exactly one launch method, and they are resolved in the order `npx`, `binary`, `uvx`, so listing
more than one silently ignores the rest.

Pin versions where the launcher takes one. An unpinned package means whatever the registry serves
at spawn time runs on this machine.

**Merge, never overwrite.** Read the file first if it exists, keep the entries already in it, and
append or replace only the one being discussed. The top level is `{ "agents": [ ... ] }`.

## Secrets

This file is plain text in the user's home directory. Before writing an API key into it, say so and
let them decide. A variable already exported in the environment Maestro was launched from is
inherited by the agent, so it can be left out of the file entirely — that works for a terminal
launch, but not reliably for a GUI launch on macOS, which does not read shell startup files.

## After writing

Check the file parses as JSON — a malformed one is skipped whole, and the agents already in it
disappear with it.

Then tell the user the new agent appears in the picker within about five minutes, or immediately if
they restart Maestro: agent discovery is cached per connection for that long.

Custom agents are trusted as installed on the user's say-so, so the entry shows up in the picker
whether or not the command works, and a bad `package` or `cmd` surfaces as a failure when a session
is started with it. That is why the checks above are worth running before writing.
