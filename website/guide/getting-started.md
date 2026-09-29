# Getting started

## Install

Get the build for your system from the [download page](../download). No Maestro account is required: there is no Maestro service to register for or sign in to.

## Before you start

### A coding agent

Install and authenticate the agent you want to use before pointing Maestro at it. Maestro launches it, but the subscription, model access and usage charges stay with the agent's provider. Some agents launch through `npx` or `uvx` rather than a standalone binary, so depending on your choice you may also need [Node.js](https://docs.npmjs.com/cli/v11/commands/npx) or [uv](https://docs.astral.sh/uv/guides/tools/).

The agent picker lists the agents bundled in Maestro's registry. For one it does not ship — a local model behind Ollama, an in-house ACP adapter, a listed agent with a different endpoint — add it in `~/.maestro/custom-agents.json`. Run `/maestro-custom-agents` in any agent session and the agent writes the file for you, or follow [Custom agents](./custom-agents).

### Git, ideally

Maestro runs in a plain folder, but the workflow below assumes a git repository. Git is what makes worktrees, parallel tasks, the diff review and the merge, push and pull-request actions possible. Without it, agents edit the folder directly and finished tasks go straight to **Done**.

### Where secrets live

Maestro keeps no remote or integration credentials in its database. SSH passwords, key passphrases and issue-tracker or code-hosting tokens go into your operating system's keychain when you choose to save them. If the keychain is unavailable, integration tokens fall back to an encrypted local file with a visible warning; SSH secrets are never stored that way. Your agent's own credentials are the agent's business, not Maestro's.
