# deer

> One-line description / tagline

<!-- screenshot or demo gif here -->

## What is deer?

<!-- Short paragraph: what problem does it solve, who is it for -->

## How it works

<!-- Brief conceptual overview:
  - TUI dashboard (Ink/React)
  - Spawns Claude Code agents in isolated sandboxes (Anthropic SRT)
  - Each task gets a git worktree + tmux session
  - Network filtered via allowlist proxy; credentials never enter sandbox
  - On completion: branch pushed, PR opened via gh
-->

## Requirements

- macOS or Linux (x64 / arm64)
- [Claude Code](https://claude.ai/code) CLI (`claude`) — logged in
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated (`gh auth login`)
- `tmux`
- macOS: `sandbox-exec` (built-in)
- Linux: `bubblewrap` (`bwrap`)

## Credentials

<!-- Explain the two auth modes and how the token is sourced:
  1. Claude subscription (OAuth) — read from macOS Keychain automatically,
     or placed manually in ~/.claude/agent-oauth-token
  2. Anthropic API key — ANTHROPIC_API_KEY env var
  Note: credentials never enter the sandbox; the host-side auth proxy injects them
-->

## Installation

```sh
npx @zdavison/deer
```

<!-- Note about PATH: ~/.local/bin must be in PATH -->

## Usage

Run `deer` from inside any git repository:

```sh
cd your-repo
deer
```

<!-- Describe the TUI:
  - Type a prompt and press Enter to start a task
  - Each task appears as a row showing status, elapsed time, PR link
  - Keyboard shortcuts (attach, kill, retry, open shell, create/update PR, delete)
-->

### Keyboard shortcuts

<!-- Table of shortcuts shown in the ShortcutsBar -->

## Configuration

### Global config

`~/.config/deer/config.toml`

<!-- Full schema reference -->

### Repo-local config

`deer.toml` in your repository root (safe to commit):

```toml
# Override the default base branch
# base_branch = "master"

# Command to run inside the container before the agent starts
# setup_command = "pnpm run setup"

# Additional domains to allow through the network proxy
# [network]
# allowlist_extra = ["npm.pkg.github.com"]

# Environment variables injected into the agent container
# [env]
# NODE_ENV = "development"
```

#### Config options

| Option | Default | Description |
|--------|---------|-------------|
| `base_branch` | repo default | Branch new task branches are based on |
| `setup_command` | — | Shell command run inside sandbox before the agent starts |
| `network.allowlist_extra` | `[]` | Extra domains added to the network allowlist |

### Default network allowlist

<!-- List the built-in allowed domains:
  api.anthropic.com, claude.ai, statsig.anthropic.com, sentry.io, registry.npmjs.org -->

### Passing secrets into the sandbox

<!-- Explain env_passthrough and proxy_credentials for custom registries / tokens -->

## Security model

<!-- Explain:
  - Sandbox isolation (SRT: bwrap on Linux, seatbelt/sandbox-exec on macOS)
  - Worktree is the only writable directory
  - Host env vars not leaked; only explicitly passthrough'd vars reach the sandbox
  - Network filtered to allowlist
  - Auth proxy: credentials stay on host, injected as headers by MITM proxy
-->

## Building from source

```sh
bun install
bun run dev       # run from source
bun run build     # compile binary
bun test          # run tests
```

## Contributing

<!-- Contribution guidelines, PR process, etc. -->

## License

<!-- License -->
