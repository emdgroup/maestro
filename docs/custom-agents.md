# Custom agents

Maestro's agent picker lists the agents from a registry bundled in the app. Anything it does not
ship — a local model served through Ollama or another Anthropic-compatible gateway, an in-house
ACP adapter, a second profile of a listed agent pointed at a different endpoint — goes in
`~/.maestro/custom-agents.json` (`%USERPROFILE%\.maestro\custom-agents.json` on Windows).

## Two ways to write the file

**With an agent.** Run `/maestro-custom-agents` in any agent session, inside Maestro or in a
terminal. Maestro installs that skill on every machine it connects to, so the agent knows the
format: it asks what you want to add and writes the file for you. It is a slash command, so it
never fires on its own.

**By hand.** One entry per agent, each with an `id`, a `name` and exactly one launch method:

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

That example adds nothing new to your machine. It is the same Claude Code ACP package Maestro
already ships, launched with a different environment — Ollama's endpoint instead of Anthropic's,
and gateway model discovery on so Maestro's model selector lists the models you have pulled
locally. Your normal Claude Code entry keeps working alongside it.

## Launch methods

| Method   | Shape                                            | Notes                                                        |
| -------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `npx`    | `{ "package": "...", "args": [], "env": {} }`    | Only method that accepts `env`                               |
| `uvx`    | `{ "package": "...", "args": [] }`               | `env` is ignored                                             |
| `binary` | `{ "<platform>": { "cmd": "...", "args": [] } }` | `cmd` is a name on `PATH` or an absolute path; `env` ignored |

`<platform>` is one of `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, `linux-x86_64`,
`windows-x86_64`, `windows-aarch64`. An agent that needs environment variables either goes through
`npx` or reads them from a wrapper script named as `cmd`.

## Rules

- The file belongs to the machine that **runs** the agent. For a project on an SSH host, in WSL,
  or in a container, write it in that machine's home directory, not on your laptop.
- Custom agents are additive. An `id` that collides with a bundled agent is ignored rather than
  replacing it.
- Maestro trusts that a custom agent is installed. A wrong package or command shows up as a
  failure when you start a session with it, not as a missing entry in the picker.
- A new entry reaches the picker within about five minutes, or immediately after restarting
  Maestro.
- The file is plain text in your home directory. Treat any API key you put in `env` accordingly.
