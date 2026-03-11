# deer

Unattended coding agent — runs Claude Code inside a sandboxed tmux session, one git worktree per task.

## Stack

- **Runtime**: Bun (not Node)
- **UI**: Ink (React for terminal) + `@inkjs/ui`
- **Sandbox**: `@anthropic-ai/sandbox-runtime` (SRT — bwrap on Linux, seatbelt on macOS)
- **Config**: TOML via `@iarna/toml`
- **Language**: TypeScript (ESM, `"type": "module"`)

## Commands

```sh
bun run dev          # run from source
bun test             # run all tests
bun run build        # compile linux-x64 binary to dist/
```

## Architecture

Each agent task follows: **worktree → sandbox → poll → finalize**

- `src/cli.tsx` — entrypoint; detects repo root, renders Dashboard
- `src/dashboard.tsx` — Ink TUI; task list, log panel, prompt input
- `src/agent.ts` — `startAgent()` / `destroyAgent()` / `deleteTask()`; manages worktree + sandbox lifecycle
- `src/sandbox/` — SRT sandbox launch, tmux session management, auth proxy
- `src/sandbox/auth-proxy.ts` — host-side MITM proxy; injects credentials so sandbox never sees raw secrets
- `src/git/worktree.ts` — create/remove git worktrees; each task gets `deer/<taskId>` branch
- `src/git/finalize.ts` — PR creation, branch cleanup after agent completes
- `src/config.ts` — config loading (global `~/.config/deer/config.toml` → repo `deer.toml` → CLI overrides)
- `src/task.ts` — task ID generation, history persistence (`~/.local/share/deer/`)
- `src/state-machine.ts` — agent state transitions
- `src/constants.ts` — all tunable constants in one place

## Data & Paths

- Task data: `~/.local/share/deer/tasks/<taskId>/`
- Worktrees: `~/.local/share/deer/tasks/<taskId>/worktree`
- History: `~/.local/share/deer/history/<repo-hash>.jsonl`
- Prompt history: `~/.local/share/deer/prompt-history.json`
- Global config: `~/.config/deer/config.toml`
- Repo config: `<repo>/deer.toml` (safe to commit; see `deer.toml.example`)

## Config

`deer.toml` (repo-local, additive — never replaces global defaults entirely):

```toml
base_branch = "main"
setup_command = "bun install"

[network]
allowlist_extra = ["npm.pkg.github.com"]

[sandbox]
env_passthrough_extra = ["NODE_ENV"]
```

Global config uses the same structure but with full replacement semantics for arrays.

## Auth / Credentials

Credentials stay on the host. The sandbox receives placeholder env vars (`proxy-managed`) and HTTP base URLs routed through an auth MITM proxy (Unix socket). The proxy injects real `Authorization` / `x-api-key` headers before forwarding to HTTPS upstream.

Priority: `CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_API_KEY`

## Testing

```sh
bun test                          # all tests
bun test test/agent.test.ts       # single file
```

Tests in `test/`. Security tests in `test/security/` cover API key isolation, filesystem escape, and network exfiltration.

## Release

Tag `v*` triggers `.github/workflows/release.yml` — builds binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64 and publishes a GitHub release.
