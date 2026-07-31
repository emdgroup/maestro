---
name: maestro-custom-agents
description: Add an agent to the Maestro desktop app's picker that its bundled registry does not ship — a local model served through Ollama or another Anthropic-compatible gateway, an in-house ACP adapter, or a second profile of a listed agent with different environment variables. Writes ~/.maestro/custom-agents.json.
disable-model-invocation: true
---

# Adding a custom agent to Maestro

The user ran `/maestro-custom-agents`. Anything they typed after it is the agent they want added —
treat it as the answer to the first question below and do not ask it again.

Maestro's agent picker is filled from a registry bundled inside the app. It is deliberately fixed:
its entries decide which executable gets spawned, so it is reviewed as a supply-chain surface and
updated by release. Nothing in it can be edited from the UI, and editing the app's source to add
an agent means maintaining a fork.

The escape hatch is `~/.maestro/custom-agents.json` — a file the user owns, read fresh every time
Maestro lists agents, holding only their own entries. Anything expressible as "run this command
with these arguments and these environment variables, speaking ACP on stdio" belongs here.

## First, find out what they actually want

Do not guess an entry and write it. One round of questions, then write once:

1. **What launches the agent?** An npm package run with `npx`, a Python package run with `uvx`,
   or a binary already installed on the machine. If they name a product rather than a command,
   ask which of the three it is — or check whether the binary is on `PATH`.
2. **What should it be called in the picker?** That is `name`. Derive `id` from it yourself:
   lowercase, hyphenated, stable, since it is what sessions are recorded against.
3. **Which environment variables does it need?** Base URL, API key, model. This is the whole point
   of a custom entry for gateway setups — see the Ollama recipe below.

If they are pointing an existing agent somewhere new, say Claude Code at a local model, this is a
**second entry alongside** the bundled one, never a replacement. An id that collides with a
bundled agent is rejected and logged; the bundled agent keeps working.

## Where the file goes

`~/.maestro/custom-agents.json` on the machine that **runs the agent** — `%USERPROFILE%\.maestro\`
on Windows. For a project on an SSH host, in WSL or in a container, that is the remote home
directory, not the laptop's, because the command and its `PATH` are resolved there.

## The file

```json
{
  "agents": [
    {
      "id": "my-agent",
      "name": "My Agent",
      "icon": "https://example.com/icon.svg",
      "distribution": {
        "npx": {
          "package": "@scope/some-acp-adapter@1.2.3",
          "args": ["--acp"],
          "env": { "SOME_API_KEY": "..." }
        }
      }
    }
  ]
}
```

`id`, `name` and `distribution` are required; everything else is optional. `icon` is a URL and
most custom agents simply omit it — Maestro falls back to a generic mark rather than failing.

`distribution` holds exactly one launch method:

| Method   | Shape                                               |
| -------- | --------------------------------------------------- |
| `npx`    | `{ "package": "...", "args": [...], "env": {...} }` |
| `uvx`    | `{ "package": "...", "args": [...] }`               |
| `binary` | `{ "<platform>": { "cmd": "...", "args": [...] } }` |

`binary` platform keys are `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, `linux-x86_64`,
`windows-x86_64`, `windows-aarch64`; only the ones the user runs on need to be present. `cmd` is
either a bare name resolved on `PATH` or an absolute path taken verbatim.

**Merge, never overwrite.** Read the file first if it exists, keep the entries already in it, and
append or replace only the one being discussed.

Pin versions where the launcher takes one — `@scope/adapter@1.2.3` rather than a floating tag.
An unpinned package means whatever the registry serves at spawn time runs on this machine.

## Recipe: local models through Ollama

The Claude Code ACP adapter talks to any Anthropic-compatible endpoint, and Ollama serves one. So
a local model needs no new adapter, only the bundled agent's package with a different environment:

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

`ANTHROPIC_AUTH_TOKEN` is a placeholder Ollama ignores, but the adapter refuses to start without
credentials. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` makes the adapter ask the endpoint which
models it serves, which is what fills Maestro's model selector with the user's installed Ollama
models — without it the selector offers Anthropic's hosted names, none of which the gateway has.

The same shape works for any Anthropic-compatible gateway: change the base URL, and use the real
key as `ANTHROPIC_AUTH_TOKEN` where one is needed. `ANTHROPIC_MODEL` pins a single model if the
user would rather not pick one per session.

## Secrets

This file is plain text in the user's home directory. Before writing an API key into it, say so
and let them decide. A variable already exported in the environment Maestro was launched from is
inherited by the agent, so it can be left out of the file entirely — that works for a terminal
launch, but not reliably for a GUI launch on macOS, which does not read shell startup files.

## After writing

Check the file parses as JSON — a malformed one is skipped whole, and the agents already in it
disappear with it.

Then tell the user that the new agent appears in the picker within about five minutes, or
immediately if they restart Maestro: agent discovery is cached per connection for that long.

A wrong command is not caught here. Custom agents are trusted as installed on the user's say-so,
so the entry shows up in the picker either way, and a bad `package` or `cmd` surfaces as a failure
when a session is started with it.
