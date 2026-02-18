# Deer: Unattended Coding Agent

## Overview

Deer is a CLI tool that takes a task description (text or URL), spins up an isolated environment for a coding agent, and delivers a pull request with the completed work. The agent runs unattended in a sandboxed container with controlled filesystem and network access.

**Workflow:**

```
# Run from within a git repo — repo is autodetected
deer "https://notion.so/task/123"

# Or with explicit repo
deer --repo github.com/org/repo "Fix the login bug on mobile"

# Interactive mode — just run deer, get a text box
deer
```

> The ideal UX is running `deer` in a repo and getting an "anything" text box — paste a URL, type a description, or point to a plan file. Deer figures out what to do.

```
deer run
  │
  ├── 1. Detect repo (cwd or --repo), resolve task input
  ├── 2. Create worktree + branch
  ├── 3. Build devcontainer image (cached by config hash)
  ├── 4. Set up network isolation (Squid proxy + internal Docker network)
  ├── 5. Register per-task workload in boilerhouse + claim container
  ├── 6. Agent works autonomously (sandboxed, yolo mode, via boilerhouse execStream)
  ├── 7. Agent finishes → commit, push, open PR
  └── 8. Release container, delete workload, cleanup
```

---

## Prior Art & Ecosystem Analysis

### tsk (github.com/dtormoen/tsk)

**What it is:** A Rust CLI that delegates coding tasks to AI agents (Claude Code, Codex) in Docker containers. MIT licensed, solo maintainer, very active.

**Useful patterns to adopt:**

| Pattern                                   | Details                                                        |
|-------------------------------------------|----------------------------------------------------------------|
| Agent abstraction                         | Clean trait: build_command, volumes, environment, validate      |
| Network isolation                         | Squid proxy + domain allowlists + internal Docker networks     |
| Dual-lock git sync                        | tokio::Mutex (in-process) + flock (cross-process)              |
| Template system                           | Handlebars markdown templates for agent prompts                |

**Decision: Don't fork.** 4 of 6 needed features are architectural divergences (devcontainer, HTTP API, K8s, URL input). Solo maintainer rewrites external PRs. We adopt tsk's patterns, not its code.

### nono.sh

**What it is:** Kernel-enforced sandbox (Landlock/Seatbelt) for AI agents. Early alpha.

**Verdict:** Not suitable as primary isolation (all-or-nothing network). Possible defense-in-depth layer inside containers later.

### Devbox (jetify.com/devbox)

**What it is:** Nix-powered CLI for reproducible dev environments via `devbox.json`.

**Verdict:** Deer should support `devbox.json` as a fallback — run `devbox generate devcontainer` for repos that have devbox but no devcontainer config. Not needed for v1 (MeetsMore already has `.devcontainer/`).

### Boilerhouse (/home/z/Desktop/work/boilerhouse)

**What it is:** A multi-tenant container pool orchestrator. TypeScript/Bun monorepo. REST API + CLI. Manages pools of pre-warmed Docker containers with tenant isolation, lifecycle hooks, state sync (S3/rclone), health checks, and Prometheus metrics.

**What it already provides:**

| Capability                       | Status          | Details                                                    |
|----------------------------------|-----------------|------------------------------------------------------------|
| Container create/start/stop      | Implemented     | Pooled, pre-warmed, fast claim                             |
| Exec into containers             | Implemented     | `ContainerRuntime.exec()`                                  |
| Filesystem isolation             | Implemented     | Per-tenant volume wipe on claim                            |
| Network config                   | Implemented     | Configurable networks, DNS override per container          |
| Health checks + readiness        | Implemented     | Configurable health check commands                         |
| Lifecycle hooks                  | Implemented     | `post_claim`, `pre_release` (exec-in-container)            |
| State sync (S3)                  | Implemented     | Bidirectional rclone sync on claim/release/periodic        |
| REST API                         | Implemented     | Full CRUD for pools, containers, tenants, sync             |
| CLI                              | Implemented     | claim, release, status, shell, sync ops                    |
| Prometheus metrics               | Implemented     | Pool, container, sync, HTTP metrics + Grafana dashboard    |
| Idle timeout + auto-cleanup      | Implemented     | Filesystem mtime-based idle reaper                         |
| Recovery on restart              | Implemented     | Docker reconciliation on startup                           |
| Resource limits                  | Implemented     | CPU, memory, tmpfs, security hardening                     |
| `ContainerRuntime` interface     | Designed        | Clean trait, K8s noted as future implementation            |
| Kubernetes runtime               | Not implemented | Interface ready, needs `KubernetesRuntime` implementation  |
| Image building                   | Not implemented | Assumes pre-built images                                   |
| Devcontainer support             | Not implemented | Uses its own YAML workload spec format                     |
| Git/repo management              | Not implemented | Not its concern                                            |

**What's missing (gaps deer would bridge):**

| Gap                              | How deer fills it                                              |
|----------------------------------|----------------------------------------------------------------|
| No devcontainer→WorkloadSpec     | Deer translates devcontainer.json to boilerhouse workload YAML |
| No image building                | Deer builds devcontainer images, pushes to registry            |
| No git/repo management           | Deer handles worktrees, branching, pushing, PRs                |
| No agent orchestration           | Deer manages Claude Code invocation, prompt construction       |
| No task input parsing            | Deer fetches from Notion, GitHub, web, files                   |
| No K8s runtime                   | Implement in boilerhouse — deer benefits automatically         |

#### Decision: Boilerhouse is the container backend for deer (Phase 2+)

The separation of concerns is clean:
- **Boilerhouse** = container platform (lifecycle, pooling, isolation, health, metrics)
- **Deer** = coding agent workflow (git, tasks, agent, PRs)

Deer uses boilerhouse from Phase 1 onward — no duplicate container lifecycle code. Deer uses `devcontainer build` for image building (complex feature/Dockerfile composition), then delegates all container lifecycle to boilerhouse via its REST API. This gives us health checks, timeout enforcement, lifecycle hooks, metrics, and a path to K8s from day one.

For Phase 1, deer creates a **per-task workload** in boilerhouse with all task-specific config (worktree mount, credentials, network) baked into the WorkloadSpec. The pool is configured with `min_idle: 0` (cold-start) and `idle_timeout: 0s` (destroy on release). After the task, the workload is deleted. For Phase 2+ (warm pooling, concurrent tasks), deer refactors to per-repo workloads with per-claim overrides.

This also resolves the language question. Since we're not forking tsk and our container platform is TypeScript/Bun, deer should be TypeScript/Bun too. Same ecosystem, code sharing possible, team already knows the stack.

---

## Case Study: MeetsMore Monorepo

The MeetsMore monorepo is the first target. Understanding its environment shapes deer's design.

### Project Overview

| Aspect       | Details                                                                      |
|--------------|------------------------------------------------------------------------------|
| Stack        | Node.js 22.22.0, TypeScript 5.9, pnpm 10.28, Turborepo 2.6                  |
| Structure    | Monorepo: `meetsmore/` (main app), `apps/` (12 services), `@meetsmore/` (23 packages) |
| Backend      | NestJS 11, MongoDB, PostgreSQL, Redis, Elasticsearch, RabbitMQ               |
| Frontend     | React 17, Vite, Tailwind CSS 3.4, MUI, Redux Toolkit                        |

### Dev Environment (Devcontainer)

- **Base:** `mcr.microsoft.com/devcontainers/base:ubuntu-24.04`
- **Features:** Node.js 22.22.0, pnpm 10.28, Claude Code, Docker-outside-of-Docker, GitHub CLI
- **Network:** `--network=host`
- **Databases:** `docker-compose.yml` (MongoDB, Redis, Elasticsearch, PostgreSQL, RabbitMQ, Nittei)
- **Credentials:** `~/.claude/`, `~/.claude.json`, `~/.config/gh/` mounted
- **Env vars:** `GITHUB_NPM_TOKEN` required for private packages
- **Setup:** `pnpm run setup` (installs deps, builds shared packages, starts services)

### How Deer Works with This Repo

```
cd /path/to/meetsmore/monorepo
deer "Fix the login timeout bug on mobile — see https://notion.so/meetsmore/abc123"
```

Pipeline:
1. **Detect:** Repo is autodetected from cwd, base branch is `master`
2. **Git:** Create worktree → `deer/feat/fix-login-timeout/deer_01HYX3`
3. **Container:** Build devcontainer from existing `.devcontainer/` config (with network override)
4. **Services:** Start `docker-compose up -d` for databases, wait for health checks
5. **Setup:** Run `pnpm run setup` inside container
6. **Agent:** Claude Code with task instruction, yolo mode
7. **Finalize:** Commit, push, `gh pr create`
8. **Cleanup:** Container down, worktree remove, docker-compose down

**Complications deer must handle:**
- `--network=host` must be overridden with isolated network + proxy
- Credential mounts provided by deer, not reliant on host paths
- docker-compose services need health-check readiness loop before agent starts
- `pnpm run setup` is slow — image caching critical for repeat runs

---

## Architecture

### Design Principles

1. **Zero-config for repos with devcontainers** — `deer` in a repo with `.devcontainer/` just works
2. **Container-first isolation** — Devcontainers for environment, network proxy for egress control
3. **Worktree-based git** — Lightweight branching locally, shallow clone in K8s
4. **Boilerhouse for container management** — Pooling, lifecycle, metrics from Phase 2
5. **Cloud-portable** — Every local operation has a K8s equivalent

### Container Resolution

```
1. .devcontainer/devcontainer.json exists → devcontainer CLI (v1)
2. devbox.json exists (no .devcontainer/) → devbox generate devcontainer, then devcontainer CLI
3. Neither exists → generate minimal devcontainer (Ubuntu + agent)
```

### Component Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                           Entry Points                                 │
│  ┌───────────┐  ┌──────────────────┐  ┌─────────────────────────────┐  │
│  │ CLI (v1)  │  │ Chrome Extension │  │ GitHub App / Webhook        │  │
│  │ deer "…"  │  │ (v3)             │  │ (v3)                        │  │
│  └─────┬─────┘  └────────┬─────────┘  └──────────────┬──────────────┘  │
│        │                 │                            │                 │
│        └─────────────────┴──────────┬─────────────────┘                 │
│                                     ▼                                  │
│                           ┌──────────────────┐                         │
│                           │   Task Router     │                         │
│                           │  (parse input,    │                         │
│                           │   detect repo)    │                         │
│                           └────────┬─────────┘                         │
│                                    ▼                                   │
│                           ┌──────────────────┐                         │
│                           │   Task Queue      │                         │
│                           │   (SQLite/Pg)     │                         │
│                           └────────┬─────────┘                         │
│                                    ▼                                   │
│                           ┌──────────────────┐                         │
│                           │  Task Executor    │                         │
│                           │  (worker pool)    │                         │
│                           └────────┬─────────┘                         │
│                                    ▼                                   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Per-Task Pipeline                            │   │
│  │                                                                 │   │
│  │  1. Git Setup       ─ worktree add, branch create               │   │
│  │  2. Image Build      ─ devcontainer build (cached by config hash)│   │
│  │  3. Container        ─ boilerhouse: register workload → claim   │   │
│  │     Lifecycle           (per-task workload, cold-start pool)     │   │
│  │  3. Network Setup   ─ Squid proxy + internal Docker network     │   │
│  │  4. Project Setup   ─ Run setup commands (pnpm install, etc.)   │   │
│  │  5. Agent Run       ─ claude -p --dangerously-skip-permissions  │   │
│  │  6. Git Finalize    ─ commit, push                              │   │
│  │  7. PR Create       ─ gh pr create                              │   │
│  │  8. Cleanup         ─ release container, worktree remove        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Boilerhouse (Phase 2+)                      │   │
│  │  Container pool ── lifecycle hooks ── health checks ── metrics  │   │
│  │  REST API ── Docker runtime ── (future: K8s runtime)            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### Core Data Model

```typescript
interface Task {
  id: string;                      // @example "deer_01HYX3..."
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  repo: string;                    // @example "github.com/org/repo" — autodetected from cwd
  baseBranch: string;              // @example "main"
  workBranch: string;              // @example "deer/feat/add-auth/deer_01HYX3"
  instruction: string;             // Full task text (resolved from URL if needed)
  instructionSource: string;       // @example "https://notion.so/task/123" or "inline"
  agent: "claude";                 // Agent to use (claude for v1)
  envStrategy: "devcontainer" | "devbox" | "default";
  networkAllowlist: string[];      // @example ["api.anthropic.com", "registry.npmjs.org"]
  env: Record<string, string>;     // @example { "GITHUB_NPM_TOKEN": "ghp_..." }
  containerId: string | null;      // Boilerhouse container ID (Phase 2+)
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  prUrl: string | null;            // @example "https://github.com/org/repo/pull/42"
  error: string | null;
  parentTaskId: string | null;     // For task chaining
}
```

---

## Implementation Plan

### Phase 0: Project Scaffolding

TypeScript/Bun project. Not a fork of anything.

```
deer/
  src/
    cli.ts               # CLI entry point (interactive + flags)
    task.ts              # Task data model + ID generation
    config.ts            # Configuration loading (TOML)
    pipeline.ts          # Per-task execution pipeline orchestrator
    git/
      worktree.ts        # git worktree add/remove, branch management
      sync.ts            # Cross-process locking (flock on .git/deer.lock)
      push.ts            # Push + PR creation (gh CLI wrapper)
    container/
      resolver.ts        # Detect strategy: devcontainer / devbox / default
      devcontainer.ts    # devcontainer CLI wrapper (up, exec, down)
      augment.ts         # Augment devcontainer.json (network, creds, features)
      network.ts         # Squid proxy container + internal Docker network
    agent/
      types.ts           # Agent interface
      claude.ts          # Claude Code: command construction, credential mounts
    input/
      detect.ts          # Detect input type: URL / file / text
      notion.ts          # Notion page → markdown
      github.ts          # GitHub issue → markdown
      web.ts             # Generic URL → markdown (readability)
    store/
      types.ts           # TaskStore interface
      sqlite.ts          # SQLite implementation (bun:sqlite)
  package.json
  tsconfig.json
  deer.toml.example
```

Key dependencies:
- `bun:sqlite` — Task persistence (built-in, zero deps)
- `@anthropic-ai/claude-code` — Claude Code SDK (if available) or shell out
- `simple-git` or shell out — Git operations
- `@iarna/toml` — Config parsing
- `dockerode` — Docker API client (same as boilerhouse — enables code sharing)

### Phase 1: Core Pipeline (MVP)

Goal: `deer "task description"` in a repo with `.devcontainer/` produces a PR. Container lifecycle managed by boilerhouse from the start.

#### 1.1 CLI & Repo Detection

```typescript
// deer "Fix the login bug"         → task is the positional arg
// deer --repo ./path "Fix bug"     → explicit repo
// deer                             → interactive mode (prompt for input)

// Repo detection:
// 1. --repo flag if provided
// 2. Walk up from cwd looking for .git/
// 3. Error if not in a git repo
```

#### 1.2 Git Worktree Support

```
Original repo: /path/to/repo/.git/worktrees/deer_01HYX3/
Worktree: ~/.local/share/deer/tasks/deer_01HYX3/worktree/
```

- `createWorktree(repoPath, taskId, baseBranch)` → `git worktree add -b <branch> <path> <base>`
- `finalizeWorktree(worktreePath)` → commit uncommitted changes, push
- `removeWorktree(repoPath, worktreePath)` → `git worktree remove`
- Cross-process locking via `flock` on `.git/deer.lock`

#### 1.3 Devcontainer Image Building + Boilerhouse Lifecycle

**Image building** uses `devcontainer build` (for complex feature/Dockerfile composition):

```typescript
// devcontainer build --workspace-folder <worktree> --image-name deer/<repo>:<config-hash>
// Image is cached by devcontainer.json content hash — rebuild only when config changes
```

**Container lifecycle** is managed by boilerhouse. Deer creates a per-task workload with:
- The built devcontainer image
- Task worktree as a custom volume mount
- Credential mounts (Claude, gh CLI, SSH agent) as custom volumes
- Task-specific Docker network (for Squid proxy isolation)
- Per-task environment variables
- Setup command as `post_claim` lifecycle hook
- Pool: `min_idle: 0`, `max_size: 1`, `idle_timeout: 0s` (cold-start, destroy on release)

```typescript
// 1. bh.createWorkload(spec)  — register per-task workload
// 2. bh.claim(taskId, poolId) — pool creates container on-demand
// 3. bh.execStream(...)       — run agent with real-time output streaming
// 4. bh.release(taskId)       — release container (pool destroys it)
// 5. bh.deleteWorkload(id)    — clean up workload + pool
```

For Phase 2 (warm pooling), deer refactors to per-repo workloads with per-claim overrides.

#### 1.4 Network Isolation

Squid proxy pattern (adopted from tsk):

```
deer-proxy (shared singleton container)
  └── Squid with domain allowlist
  └── iptables rules

deer-net-{task_id} (Docker internal network, no external gateway)
  └── agent container
  └── connected to deer-proxy
```

Default allowlist:
```
api.anthropic.com
statsig.anthropic.com
sentry.io
registry.npmjs.org
pypi.org
github.com
objects.githubusercontent.com
```

Per-repo extensions via `deer.toml` or `~/.config/deer/config.toml`.

#### 1.5 Task Input

Detection: URL → fetch and convert to markdown. File path → read. Otherwise → raw text.

v1 fetchers: GitHub issues (`gh issue view`), generic web pages (fetch + readability).
Later: Notion API, Linear API, Jira API.

#### 1.6 Agent Invocation

```typescript
const agentCommand = [
  "claude", "-p",
  "--dangerously-skip-permissions",
  "--verbose",
  "--output-format", "stream-json",
].join(" ");

// Pipe task instruction via stdin:
// cat /tmp/deer/task.md | <agentCommand>
```

The agent runs inside the devcontainer with:
- Full access to the worktree (workspace)
- Read-only Claude credentials
- Network restricted to allowlisted domains
- The project's CLAUDE.md guiding its behavior

#### 1.7 PR Creation

After agent completes:
1. Commit any uncommitted changes in worktree
2. `git push origin <branch>`
3. `gh pr create --title "<generated>" --body "<template>"`
4. Assign the PR to the user who invoked deer

PR body:
```markdown
## Task

{task_description_or_link}

## Changes

{summary_from_agent_or_diff}

---
*Generated by deer using Claude Code*
```

#### 1.8 Credential Handling

| Credential          | Source                                     | Injection                               |
|---------------------|--------------------------------------------|-----------------------------------------|
| Claude API/OAuth    | `~/.claude/`, `~/.claude.json`             | Bind mount (read-only)                  |
| GitHub (for PRs)    | `gh auth token` or config                  | Env var `GH_TOKEN`                      |
| Git (for push)      | SSH agent                                  | `SSH_AUTH_SOCK` forwarding              |
| Private registries  | `~/.config/deer/config.toml`               | Env var (e.g., `GITHUB_NPM_TOKEN`)      |

### Phase 2: Server Mode + Warm Pooling

Phase 1 already uses boilerhouse with per-task workloads (cold-start). Phase 2 adds server mode and refactors to per-repo workloads with warm container pooling for faster task start times.

Boilerhouse remains an implementation detail. Users never configure pools, claim containers, or think about workload specs. They just run `deer` and it works.

#### 2.1 Task Queue

```
deer server start --workers 4       # Start server with worker pool
deer add "Fix the login bug"        # Queue a task
deer list                           # List tasks
deer logs <task-id>                 # Stream logs
deer cancel <task-id>               # Cancel running task
```

SQLite-backed queue (`bun:sqlite`). Worker pool with concurrency control. Poll every 2s.

#### 2.2 Per-Repo Workloads + Warm Pooling

Phase 1 uses per-task workloads (cold-start, one workload per task, deleted after completion). Phase 2 refactors to per-repo workloads with warm container pooling:

**Per-repo workloads:**
- One workload per repo (shared across tasks), registered once on first use
- Workload spec contains base config: image, resources, health check, credential mounts
- Per-task config (worktree, network) passed as claim-time overrides (requires new boilerhouse feature)

**Warm-pool strategy (opt-in, for high-throughput repos):**
Pre-warmed containers stay running. On claim, deer bind-mounts the worktree into the container's state volume. Boilerhouse manages the pool lifecycle. Faster task start, but more complex workspace management.

```
Repo's .devcontainer/devcontainer.json
  → deer translates to boilerhouse WorkloadSpec (once per repo)
  → deer registers workload via API (POST /api/v1/workloads)
  → boilerhouse creates pool, pre-warms containers
  → deer claims container per task with overrides (worktree mount, network)
  → deer execs agent in claimed container
  → deer releases container (POST /api/v1/tenants/:taskId/release)
  → boilerhouse wipes filesystem, returns to pool
```

#### 2.3 Configuration

```toml
# ~/.config/deer/config.toml

[defaults]
agent = "claude"
workers = 4

[network]
allowlist = [
    "api.anthropic.com",
    "statsig.anthropic.com",
    "sentry.io",
    "registry.npmjs.org",
    "github.com",
]

[repos."github.com/meetsmore/monorepo"]
base_branch = "master"
setup_command = "pnpm run setup"
env = { GITHUB_NPM_TOKEN = "ghp_..." }
network_allowlist_extra = ["npm.pkg.github.com"]
```

Per-repo config (`deer.toml` checked into repo):
```toml
base_branch = "master"
setup_command = "pnpm run setup"

[network]
allowlist_extra = ["npm.pkg.github.com"]

[env]
NODE_ENV = "development"
```

#### 2.4 Observability

- `deer logs -f <task-id>` — Real-time log streaming
- Agent JSON output parsing (Claude's `stream-json` format)
- Webhook on completion (Slack, Discord, custom)
- Retry policy (max retries, exponential backoff)
- Prometheus metrics via boilerhouse (pool utilization, task duration, etc.)

#### 2.5 Devcontainer Image Caching

- Docker layer caching (default)
- `deer build` — Pre-build and tag devcontainer image
- `deer build --push` — Push to registry (for cloud/pooling use)
- Hash-based cache key: `sha256(Dockerfile + devcontainer.json)`

### Phase 3: Multiple Entry Points

All entry points → Task → Queue → Executor:

```
CLI ────────────────┐
Chrome Extension ───┤    ┌────────────┐    ┌───────────┐
GitHub App ─────────┼───→│ HTTP API   │───→│ Task Queue│───→ Executor
Slack Bot ──────────┘    └────────────┘    └───────────┘
```

#### HTTP API

```
POST   /api/tasks          — Create task
GET    /api/tasks          — List tasks
GET    /api/tasks/:id      — Get task + status
GET    /api/tasks/:id/logs — Stream logs (SSE)
DELETE /api/tasks/:id      — Cancel task
```

Built with `Bun.serve()` + routes (per project conventions — no express).

#### Chrome Extension

"Send to Deer" button on Notion, GitHub, Linear, Jira. Right-click selected text on any page. Talks to deer's HTTP API.

#### GitHub App

Triggers from `@deer work on this` in issue/PR comments. Webhook → deer HTTP API → task.

### Future Work: Cloud Portability (Kubernetes)

> Local mode is the priority. Cloud deployment is designed-for but not built until needed.

The architecture is cloud-portable by design. When K8s support is needed:

- Implement `KubernetesRuntime` **in boilerhouse** (not in deer). Deer talks to boilerhouse's API regardless of underlying runtime.
- Switch deer's task store from SQLite to PostgreSQL (`Bun.sql`).
- Git operations change from worktrees to shallow clones (init container).
- Devcontainer images are pre-built and pushed to a registry (`deer build --push`).
- Network isolation via K8s NetworkPolicy instead of Docker internal networks.

See [Future: Cloud Deployment](#future-cloud-deployment) in the boilerhouse changes section for specifics.

---

## Technology Decisions

| Decision                    | Choice                   | Rationale                                                       |
|-----------------------------|--------------------------|-----------------------------------------------------------------|
| Language                    | TypeScript / Bun         | Same ecosystem as boilerhouse. Team knows it. Fast.             |
| Container management        | Boilerhouse (Phase 2+)   | Already built: pooling, lifecycle, metrics, K8s-ready interface |
| Container management (v1)   | Boilerhouse + devcontainer build | Boilerhouse for lifecycle, devcontainer CLI for image building only |
| Docker API client           | dockerode                | Same as boilerhouse — enables code sharing                      |
| Git operations              | simple-git or shell out  | git2 is Rust-only; shell out to git is fine for TS              |
| Task persistence            | bun:sqlite               | Built-in, zero-config, zero deps                                |
| Task persistence (cloud)    | Bun.sql (Postgres)       | Built-in Bun Postgres client                                    |
| HTTP API                    | Bun.serve()              | Per project conventions. No express.                            |
| Config format               | TOML                     | Human-readable, good for nested config                          |
| Network isolation           | Squid proxy + Docker internal networks | Proven by tsk. Granular domain control.          |
| Devcontainer CLI            | @devcontainers/cli       | Official implementation                                         |
| Devcontainer augmentation   | `--override-config`      | Does not modify repo files in the worktree                      |
| Setup script config         | `deer.toml`              | Explicit configuration, no magic auto-detection                 |

---

## Phased Delivery

| Phase | Scope                                                    | Key Deliverable                    |
|-------|----------------------------------------------------------|------------------------------------|
| 0     | TS/Bun project scaffolding, CLI skeleton, tests          | Buildable `deer` binary            |
| 1     | Worktree, boilerhouse integration, network, agent, PR    | `deer "task"` → PR (MVP)          |
| 2     | Server mode, boilerhouse integration, config, caching    | `deer server` + pooled containers  |
| 3     | HTTP API, Chrome extension, GitHub App                   | Multi-entry-point platform          |

---

## Boilerhouse Changes Required

Boilerhouse is an internal dependency we own. These are the specific changes needed to support deer, organized by priority.

### P0: Required for Phase 1 (deer MVP uses boilerhouse from the start)

#### 1. Workloads CRUD API

**Current state:** `GET /api/v1/workloads` and `GET /api/v1/workloads/:id` only. Read-only.
The `WorkloadRegistry` already has `register()`, `update()`, and `remove()` methods — they just lack API routes.

**Change:** Add `POST`, `PUT`, `DELETE` routes to `apps/api/src/routes/workloads.ts`. Deer registers per-task workloads dynamically via API. The Zod schema already exists for request validation.

**Effort:** Small. The backend methods exist, just wire up routes.

#### 2. Streaming Exec

**Current state:** `ContainerRuntime.exec()` returns `Promise<{ exitCode, stdout, stderr }>`. Buffers entire output. Agent runs for minutes to hours — this doesn't work.

**Change:** Add `execStream()` to `ContainerRuntime`:

```typescript
interface ExecStream {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitCode: Promise<number>;
  stdin?: WritableStream<Uint8Array>;
}

// In ContainerRuntime:
execStream(
  id: RuntimeContainerId,
  command: string[],
  options?: { stdin?: boolean; tty?: boolean; env?: EnvVar[] }
): Promise<ExecStream>;
```

In `DockerRuntime`, implement using dockerode's `exec.start({ hijack: true })` which already returns a raw stream. Adapt the existing demux logic (lines 232-255 of `docker-runtime.ts`) to pipe into `ReadableStream` instead of buffering.

Add an SSE endpoint: `GET /api/v1/containers/:id/exec/stream` for remote log streaming.

**Effort:** Medium. Core logic exists, needs stream plumbing.

#### 3. Per-Exec Environment Variables

**Current state:** Env vars are set at container creation time only. Docker's exec API supports an `Env` parameter, but `DockerRuntime.exec()` doesn't expose it.

**Change:** Add optional `env` parameter to `exec()` and `execStream()`:

```typescript
exec(
  id: RuntimeContainerId,
  command: string[],
  options?: { env?: EnvVar[] }
): Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

In `DockerRuntime.exec()`, pass to dockerode:
```typescript
const exec = await container.exec({
  Cmd: command,
  Env: options?.env?.map(e => `${e.name}=${e.value}`),
  AttachStdout: true,
  AttachStderr: true,
});
```

This lets deer inject per-task env vars (`GITHUB_NPM_TOKEN`, `HTTP_PROXY`, `GH_TOKEN`, `DEER_TASK_ID`) at exec time without recreating the container.

**Env var cleanup is not needed.** Docker exec env vars are scoped to the exec process only — they exist for the lifetime of that `exec` call and do not persist on the container. When the exec process exits, the env vars are gone. The next exec (for a different task after pool return) starts clean.

**Effort:** Small. One-line addition to exec, plus interface update.

#### 4. Claim-Time Timeout (Max Claim Duration)

**Current state:** `IdleReaper` handles inactivity-based auto-release (filesystem mtime). No wall-clock timeout. A runaway agent could hold a container forever.

**Change:** Add `maxClaimDurationMs` as a claim-time parameter:

```typescript
// POST /api/v1/tenants/:id/claim
body: {
  poolId: string;
  timeoutMs?: number;  // max wall-clock time for this claim
  metadata?: Record<string, unknown>;
}
```

On claim, start a `setTimeout`. When it fires, forcibly release the container. Return `expiresAt` in the claim response so deer knows the deadline.

Can be a standalone `ClaimTimeoutReaper` or integrated into the existing idle reaper loop. Cancel the timer when the container is released normally.

**Effort:** Medium. New timer management, cleanup on release.

### P1: Required for warm-pool strategy

#### 5. Workspace Volume Binding

**Current state:** All volume mounts are set at container creation time. Pooled containers are generic — they can't have repo-specific worktrees baked in. Docker doesn't support adding bind mounts to running containers.

**Problem:** Each deer task needs its git worktree (`~/.local/share/deer/tasks/<taskId>/worktree/`) mounted at `/workspaces/<repo>` inside the container. But the container is already running (pre-warmed pool).

**Change:** Add a `binds` parameter to the claim API. Boilerhouse handles the bind-mount internally — it knows where the container's state volume is on the host and can perform the `mount --bind` without exposing host paths over the API.

```typescript
// POST /api/v1/tenants/:id/claim
body: {
  poolId: string;
  timeoutMs?: number;
  binds?: Array<{
    hostPath: string;         // e.g. ~/.local/share/deer/tasks/<id>/worktree
    containerPath: string;    // path relative to state volume mount point
    readOnly?: boolean;
  }>;
}
```

On claim, boilerhouse resolves the bind-mount destination (it knows the container's stateDir internally) and performs `mount --bind`. On release, it unmounts. No host details are exposed in the API response.

**Alternative for Phase 2 MVP:** Use the cold-start strategy. No workspace binding needed — each container is created fresh with the worktree as a Docker volume mount. Warm pooling with bind-mount swapping comes later.

**Effort:** Medium.

### P1: Nice-to-have (not blocking)

#### 6. Ports Schema

**Current state:** The workload YAML examples include `ports:` but it's silently stripped by Zod validation. Port exposure is non-functional.

**Change:** Add `ports` to `workloadSpecSchema` in `packages/core/src/schemas/workload.ts`. Map to Docker's `PortBindings`/`ExposedPorts` in `ContainerManager.createContainer()`.

**Effort:** Small.

#### 7. Image Pull Support

**Current state:** If an image doesn't exist locally, `docker.createContainer()` fails. No explicit pull step.

**Change:** Add `ensureImage(image: string): Promise<void>` to `ContainerRuntime`. In `DockerRuntime`, check if image exists locally, pull if not.

**Effort:** Small.

### <a name="future-cloud-deployment"></a>Future: Cloud Deployment

These changes are needed when K8s support becomes a priority. Designed-for now, built later.

#### 8. VolumeManager Extraction

**Current state:** `ContainerManager` does host filesystem operations (`mkdir`, `chown`, `cp`, `rm`) for state/secrets/socket directories. In K8s, containers run on different nodes.

**Change:** Extract a `VolumeManager` interface:

```typescript
interface VolumeManager {
  prepareVolumes(containerId: ContainerId, workload: WorkloadSpec): Promise<VolumeMount[]>;
  wipeVolumes(containerId: ContainerId): Promise<void>;
  seedVolumes(containerId: ContainerId, workload: WorkloadSpec): Promise<void>;
  cleanupVolumes(containerId: ContainerId): Promise<void>;
}
```

Implementations:
- `HostVolumeManager` — Current behavior extracted (host dirs, mkdir/chown/rm)
- `PVCVolumeManager` — K8s: PersistentVolumeClaims, init containers for seeding/wiping

**Effort:** Large.

#### 9. KubernetesRuntime

**Change:** New package `packages/kubernetes/` implementing `ContainerRuntime`:

| ContainerRuntime method | K8s implementation                                         |
|-------------------------|------------------------------------------------------------|
| `createContainer()`     | Create Pod (or Job) via K8s API                            |
| `destroyContainer()`    | Delete Pod                                                 |
| `exec()`                | K8s exec via WebSocket to kubelet                          |
| `isHealthy()`           | Check pod status + readiness conditions                    |
| `listContainers()`      | List pods by label selector                                |

Additional interface changes:
- `VolumeMount.sourceType`: add `'hostPath' | 'pvc' | 'configMap' | 'emptyDir'`
- `ContainerSpec.imagePullPolicy`: add `'Always' | 'IfNotPresent' | 'Never'`
- `ContainerSpec.imagePullSecrets`: for private registries in K8s
- Optional `logs()` method: `logs(id, options?: { follow?; tail? }): AsyncIterable<string>`

**Effort:** Large.

#### 10. Network Isolation Primitives

**Current state:** Deer manages network isolation externally (creates Docker networks, starts Squid proxy). Boilerhouse just connects containers to specified networks.

**Future change (if boilerhouse-managed isolation is wanted):**

Add to workload/pool spec:
```yaml
network_isolation:
  mode: "proxy"
  proxy:
    image: "ubuntu/squid:latest"
    allowlist: ["api.anthropic.com", "github.com"]
```

In K8s mode, this translates to NetworkPolicy with egress rules.

**Effort:** Large.

### Summary: Boilerhouse Change Roadmap

| Priority | Change                         | Effort | Blocks              |
|----------|--------------------------------|--------|----------------------|
| P0       | Workloads CRUD API             | Small  | Phase 1 (MVP)        |
| P0       | Streaming exec                 | Medium | Phase 1 (MVP)        |
| P0       | Per-exec env vars              | Small  | Phase 1 (MVP)        |
| P0       | Claim-time timeout             | Medium | Phase 1 (MVP)        |
| P1       | Workspace volume binding       | Medium | Warm-pool strategy   |
| P1       | Ports schema                   | Small  | —                    |
| P1       | Image pull support             | Small  | —                    |
| Future   | VolumeManager extraction       | Large  | Cloud deployment     |
| Future   | KubernetesRuntime              | Large  | Cloud deployment     |
| Future   | Network isolation primitives   | Large  | — (deer manages it)  |

> Boilerhouse should be invisible to deer users. They never configure pools, claim containers, or think about workload specs. Deer auto-manages all of this: it detects the repo's devcontainer config, ensures a matching boilerhouse workload+pool exists (creating one if needed), claims a container for the task, and releases it when done. Pools grow dynamically as tasks arrive and shrink via idle reaper when load drops.

---

## Decisions Log

Resolved questions, recorded for context.

| Decision                                      | Answer                                                                              |
|-----------------------------------------------|-------------------------------------------------------------------------------------|
| Devcontainer augmentation method              | Use `--override-config` flag. Does not modify repo files in the worktree.           |
| Agent output format                           | Doesn't matter — deer creates the PR regardless. Agent can commit and describe as it likes. |
| Cost control                                  | Future work. See `docs/plans/cost-control.md` (to be created).                      |
| docker-compose services                       | Support both shared (run on host) and isolated (managed by boilerhouse). Ideally the devcontainer definition handles this. |
| Setup script detection                        | Explicit `deer.toml` config — no magic auto-detection.                              |
| Boilerhouse workload registration             | Via API (`POST /api/v1/workloads`), not filesystem YAML watching.                   |
| Human-in-the-loop                             | No review checkpoint. PR is auto-created and assigned to the user who invoked deer. |
| Monorepo scoping                              | Future work.                                                                        |
| Container pooling strategy                    | Phase 1: per-task workloads, cold-start (boilerhouse from day one). Phase 2: per-repo workloads with warm-pool opt-in. |
| Exposing host stateDir in API                 | No. Boilerhouse handles bind-mounts internally. Host paths stay server-side.        |
| Per-exec env var cleanup                      | Not needed. Docker exec env vars are process-scoped — they die with the exec.       |
| Cloud/K8s deployment                          | Designed-for, built later. Local mode is the priority.                              |
