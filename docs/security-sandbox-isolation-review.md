# Security Review: Sandbox Isolation

**Scope:** Network isolation and disk isolation of the Docker Sandbox agent environment.

---

## 1. Network Isolation

**Architecture:** After the Docker Sandbox is created, `applyNetworkPolicy()` (`src/dashboard.tsx:446`) applies `docker sandbox network proxy --policy deny` with an explicit allowlist. This is the correct approach.

### Findings

#### [MEDIUM] Pre-policy setup window has unrestricted internet

`applyNetworkPolicy` is called *after* `setupAgent` completes (`src/dashboard.tsx:1026–1029`). The `setupAgent` call includes tmux installation via `download_tmux_debs()`, which executes `apt-get` inside the sandbox and makes outbound HTTP requests to Debian mirrors. During this window the sandbox has unrestricted network access.

This is acknowledged in the code comment ("Applied after setup (tmux/apt installs are done)") and may be acceptable by design, but it is a real gap — a supply-chain attack on the apt mirror, or any code running during setup, could exfiltrate data or pull down a payload before lockdown applies.

#### [MEDIUM] PROXY_BYPASS_HOSTS allows direct, uninspected Anthropic connections

`PROXY_BYPASS_HOSTS` (`src/dashboard.tsx:439–444`) causes `api.anthropic.com`, `claude.ai`, `statsig.anthropic.com`, and `sentry.io` to bypass the MITM proxy entirely. The intent is correct (prevent the proxy from overriding OAuth auth), but the side effect is that these hosts are fully unproxied — no request inspection or logging. If a prompt injection tricks the agent into sending sensitive data to `sentry.io` or `statsig.anthropic.com`, those requests are invisible to any proxy-layer audit.

#### [LOW] Global config can silently replace the entire allowlist

In `tomlToConfig` (`src/config.ts:192–196`), `network.allowlist` from `~/.config/deer/config.toml` is extracted as a full replacement, not an extension. `deepMerge` then replaces the built-in array entirely (arrays are replaced, not merged — `src/config.ts:85`). There is no enforced minimum allowlist — a misconfigured or malicious global config can either remove all entries (blocking the agent) or expand access arbitrarily.

#### [LOW] Hostname-only allowlist — potential IP bypass

The network policy uses `--allow-host` with hostnames. If `docker sandbox network proxy` enforces this purely at the proxy layer without also blocking direct TCP to IPs, the agent could resolve a domain to an IP and connect directly, bypassing the hostname filter. This depends on Docker Desktop's sandbox proxy implementation and is not fully under deer's control.

#### [INFO] `--privileged` flag passed to sandbox exec

`docker sandbox exec --privileged` is used in `spawnClaudeInSandbox` (`src/dashboard.tsx:159`) and `startClaudeInTmux` (`src/dashboard.tsx:496`). Depending on what Docker Sandbox grants with this flag, elevated capabilities inside the container could allow modifying network namespaces or iptables rules to bypass the proxy policy.

---

## 2. Disk Isolation

**Architecture:** The sandbox mounts exactly two directories: `$WORKTREE_DIR` (a git worktree checkout) and `$GIT_DIR` (the `.git` directory of the parent repo). The agent is expected to stay within the worktree.

### Findings

#### [HIGH] OAuth token written in plaintext to a file inside the mounted GIT_DIR

`startClaudeInTmux` (`src/dashboard.tsx:478–485`) writes a launcher script to `$GIT_DIR/deer/<session>/.agent-launcher.sh` containing the plaintext OAuth token:

```sh
export CLAUDE_CODE_OAUTH_TOKEN='<token>'
```

Since `$GIT_DIR` is bind-mounted into the sandbox, the agent can read this file. The token could be written somewhere in the worktree and committed to the PR branch, or exfiltrated via a network request to an allowed host (e.g., `github.com`). Teardown deletes `DEER_TMP_DIR`, but the file is present and readable for the entire duration of the agent run.

Additionally, the token value is embedded inside single quotes without escaping. If the OAuth token contains a single quote character, the shell script breaks — potentially creating a shell injection vector in the launcher (`src/dashboard.tsx:482`).

#### [HIGH] Full `.git` directory is mounted and writable — git hook injection

`setup-sandbox.sh:126–130` mounts both `$WORKTREE_DIR` and `$GIT_DIR` into the sandbox. This gives the agent read/write access to:

- `.git/hooks/` — the agent can plant a hook (e.g. `post-commit`, `pre-push`) that executes arbitrary code on the **host** the next time any git operation triggers it. The sandbox is destroyed after the session, but the hook persists.
- `.git/config` — the agent could add malicious remote URLs or change `core.hooksPath`.
- All git objects, refs, and branches — the entire repository history across all branches is readable.
- Other active deer sessions' artifact directories under `.git/deer/`.

#### [HIGH] Other sessions' OAuth tokens readable via shared GIT_DIR

Because all deer sessions share the same `$GIT_DIR`, and each session's `DEER_TMP_DIR` is a subdirectory of `$GIT_DIR/deer/`, a running agent can read the launcher scripts of **other concurrent sessions** — each of which contains a plaintext OAuth token. This creates cross-session credential exposure.

#### [MEDIUM] Worktree path is in `/tmp` with no subdirectory scoping

`WORKTREE_DIR="$(mktemp -u)"` (`setup-sandbox.sh:108`) creates a path directly in `/tmp`. If `/tmp` is accessible within the sandbox (rather than only the specific worktree path being bind-mounted), the agent could read other processes' temporary files in the same directory.

#### [INFO] `--dangerously-skip-permissions` disables Claude Code's own file access controls

The claude invocation in both `spawnClaudeInSandbox` (`src/dashboard.tsx:163`) and the tmux launcher (`src/dashboard.tsx:484`) uses `--dangerously-skip-permissions`. Combined with the `.git` mount, this means any file in the entire repository history and all hooks directories is accessible without user confirmation.

---

## Summary

| Finding                                                         | Area    | Severity |
| --------------------------------------------------------------- | ------- | -------- |
| OAuth token in plaintext launcher script inside mounted GIT_DIR | Disk    | HIGH     |
| Cross-session token exposure via shared GIT_DIR                 | Disk    | HIGH     |
| `.git/hooks` writable — arbitrary host code execution           | Disk    | HIGH     |
| Full `.git` dir mounted (all branches, refs, other sessions)    | Disk    | HIGH     |
| Pre-policy network window during sandbox setup                  | Network | MEDIUM   |
| Bypass hosts skip proxy inspection (sentry, statsig)            | Network | MEDIUM   |
| Worktree in `/tmp` root                                         | Disk    | MEDIUM   |
| Global config can replace entire allowlist                      | Network | LOW      |
| Hostname-only allowlist — potential IP-based bypass             | Network | LOW      |
| `--privileged` exec may allow network namespace manipulation    | Network | LOW      |
| `--dangerously-skip-permissions` removes Claude Code guardrails | Disk    | INFO     |
