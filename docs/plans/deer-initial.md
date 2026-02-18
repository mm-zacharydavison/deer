# Deer: Implementation Plan (Local Dev Mode)

## Scope

Phases 0 and 1 — get `deer "task"` to produce a PR, running locally with Docker. Boilerhouse is the container backend from the start — no duplicate container lifecycle code.

**End state:** A user can `cd` into a repo with a `.devcontainer/`, run `deer "Fix the login bug"`, and get a PR with the fix. Container lifecycle is managed by boilerhouse.

**Out of scope for this plan:**
- Server mode / task queue (Phase 2)
- HTTP API / Chrome extension / GitHub App (Phase 3)
- Kubernetes / cloud deployment (Future)
- Warm container pooling (Future)
- Cost control / token budgets (Future)

---

## Prerequisites

The user's machine must have:
- Docker (for containers and network isolation)
- `devcontainer` CLI (`npm install -g @devcontainers/cli`) — used for **image building only**, not container lifecycle
- `gh` CLI (authenticated, for PR creation)
- Claude Code CLI (authenticated, `claude auth status` passes)
- Git (with push access to the target repo)
- Boilerhouse running locally (`bun run dev` in boilerhouse repo)

### Boilerhouse Prerequisites

The following boilerhouse changes (see `boilerhouse/docs/plans/deer-requirements.md`) must be implemented before or alongside deer:

| Change                   | Effort | Why                                         |
|--------------------------|--------|---------------------------------------------|
| Workloads CRUD API       | Small  | Deer registers/deletes workloads via API    |
| Per-exec env vars        | Small  | Per-task env injection at exec time         |
| Streaming exec           | Medium | Real-time agent output streaming            |
| Claim-time timeout       | Medium | Kill runaway agents after N minutes         |

Additionally, boilerhouse must support **on-demand container creation** when a pool has `min_idle: 0` and a claim arrives. If the pool currently errors when no idle containers exist, this needs a small fix to create one on-demand (up to `max_size`).

---

## Architecture: How Deer Uses Boilerhouse

Deer creates a **per-task workload** in boilerhouse with all task-specific configuration baked in. This avoids needing any per-claim override features — everything is in the WorkloadSpec.

```
deer "Fix the login bug"
  │
  ├── 1. Detect repo, resolve task input
  ├── 2. Create git worktree + branch
  ├── 3. Build devcontainer image (devcontainer build, cached)
  ├── 4. Set up network isolation (Squid proxy + internal Docker network)
  ├── 5. Register workload in boilerhouse (per-task, includes worktree mount + creds + network)
  ├── 6. Claim container from boilerhouse (pool creates it on-demand)
  ├── 7. Run setup command (if configured, via boilerhouse exec)
  ├── 8. Run agent (via boilerhouse execStream, streams output)
  ├── 9. Finalize git (commit + push in worktree on host)
  ├── 10. Create PR (gh pr create)
  └── 11. Release container + delete workload + cleanup network + cleanup worktree
```

### Per-Task Workload Spec

Each task creates a dedicated boilerhouse workload. The spec includes all task-specific config:

```yaml
id: deer-<taskId>
name: "deer task <taskId>"
image: deer/<repo-hash>:<devcontainer-hash>

volumes:
  custom:
    # Task worktree mounted as workspace
    - host_path: /home/user/.local/share/deer/tasks/<taskId>/worktree
      container_path: /workspaces/repo
    # Claude credentials (read-only)
    - host_path: /home/user/.claude
      container_path: /home/vscode/.claude
      read_only: true
    - host_path: /home/user/.claude.json
      container_path: /home/vscode/.claude.json
      read_only: true
    # GitHub CLI config (read-only)
    - host_path: /home/user/.config/gh
      container_path: /home/vscode/.config/gh
      read_only: true
    # SSH agent forwarding
    - host_path: ${SSH_AUTH_SOCK}
      container_path: /tmp/ssh-agent.sock
      read_only: true

environment:
  DEER_TASK_ID: <taskId>
  SSH_AUTH_SOCK: /tmp/ssh-agent.sock

networks:
  - deer-net-<taskId>

pool:
  min_idle: 0       # cold-start: no pre-warming
  max_size: 1       # one container per task
  idle_timeout: 0s  # destroy on release

healthcheck:
  test: ["CMD-SHELL", "echo ok"]
  interval: 10s
  timeout: 5s
  retries: 3
```

After the task completes, deer deletes the workload (and its pool) via `DELETE /api/v1/workloads/<id>`.

**Why per-task workloads instead of per-repo?**
- Each task needs a different worktree mount path, network, and credential set
- Avoids needing new boilerhouse features (per-claim volume overrides)
- Overhead is negligible — just API calls to create/delete the workload
- For Phase 2 (warm pooling, concurrent tasks), we'll refactor to per-repo workloads + per-claim overrides

---

## Phase 0: Project Scaffolding

### 0.1 Initialize Bun project

```
deer/
  src/
    cli.ts
    task.ts
    config.ts
    pipeline.ts
    git/
      worktree.ts
      sync.ts
    container/
      resolver.ts
      image.ts
      network.ts
    boilerhouse/
      client.ts
      workload.ts
    agent/
      types.ts
      claude.ts
    input/
      detect.ts
      github.ts
      web.ts
    pr.ts
  test/
    git/
      worktree.test.ts
      sync.test.ts
    container/
      resolver.test.ts
      image.test.ts
      network.test.ts
    boilerhouse/
      client.test.ts
      workload.test.ts
    agent/
      claude.test.ts
    input/
      detect.test.ts
    pipeline.test.ts
  package.json
  tsconfig.json
  deer.toml.example
  CLAUDE.md
```

### 0.2 Dependencies

```json
{
  "dependencies": {
    "@iarna/toml": "^3.0.0",
    "dockerode": "^4.0.0"
  },
  "devDependencies": {
    "bun-types": "latest",
    "@types/dockerode": "^3.3.0"
  }
}
```

No `express`, no `axios`, no `dotenv`. Use `bun:sqlite` (built-in), `Bun.file()` for file I/O, `Bun.$` for shell commands, and `fetch()` for HTTP (including the boilerhouse API client).

### 0.3 Configuration types

```typescript
// src/config.ts

interface DeerConfig {
  defaults: {
    agent: "claude";
    baseBranch?: string;
    /** @default 1800000 (30 minutes) */
    timeoutMs?: number;
  };
  boilerhouse: {
    /** @default "http://localhost:3000" */
    url: string;
  };
  network: {
    allowlist: string[];
  };
  repos: Record<string, RepoConfig>;
}

interface RepoConfig {
  baseBranch?: string;
  setupCommand?: string;
  env?: Record<string, string>;
  networkAllowlistExtra?: string[];
}

interface RepoLocalConfig {
  baseBranch?: string;
  setupCommand?: string;
  network?: {
    allowlistExtra?: string[];
  };
  env?: Record<string, string>;
}
```

Config resolution order:
1. `~/.config/deer/config.toml` (user global)
2. `deer.toml` in repo root (repo-specific, checked in)
3. CLI flags (highest priority)

### 0.4 Task data model

```typescript
// src/task.ts

interface Task {
  id: string;                // @example "deer_01jm8k3n..."
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  repo: string;              // @example "/home/user/repos/my-project"
  repoRemote: string;        // @example "github.com/org/repo"
  baseBranch: string;        // @example "main"
  workBranch: string;        // @example "deer/deer_01jm8k3n"
  worktreePath: string;      // @example "~/.local/share/deer/tasks/deer_01jm8k3n/worktree"
  instruction: string;       // Full task markdown
  instructionSource: string; // @example "https://github.com/org/repo/issues/42"
  env: Record<string, string>;
  networkAllowlist: string[];
  /** @default 1800000 (30 minutes) */
  timeoutMs: number;
  setupCommand?: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  prUrl: string | null;
  error: string | null;
}

function generateTaskId(): string {
  // Use Bun's crypto for a short, URL-safe, sortable ID
  // Format: deer_<base36-timestamp><random>
}
```

### 0.5 Tests for scaffolding

- Task ID generation produces unique, sortable IDs
- Config loading: parses TOML, merges global + repo + CLI
- Config loading: missing config file returns sensible defaults

---

## Phase 1: Core Pipeline

Implementation order is designed so each step can be tested independently before wiring into the pipeline.

### Step 1: Task Input Detection

**File:** `src/input/detect.ts`

```typescript
type InputType =
  | { kind: "url"; url: string; domain: string }
  | { kind: "file"; path: string }
  | { kind: "text"; text: string };

function detectInputType(input: string): InputType {
  // 1. Starts with http:// or https:// → url (extract domain)
  // 2. File exists at path and ends with .md or .txt → file
  // 3. Otherwise → raw text
}
```

**File:** `src/input/github.ts`

```typescript
async function fetchGitHubIssue(url: string): Promise<string> {
  // Parse owner/repo/issue-number from URL
  // Shell out: gh issue view <number> --repo <owner/repo> --json title,body,comments
  // Format as markdown: ## <title>\n\n<body>\n\n### Comments\n...
}
```

**File:** `src/input/web.ts`

```typescript
async function fetchWebPage(url: string): Promise<string> {
  // fetch(url) → HTML
  // Extract readable content (simple HTML→text)
  // Return as markdown
}
```

**Resolver:**

```typescript
async function resolveInstruction(input: string): Promise<{ instruction: string; source: string }> {
  const detected = detectInputType(input);
  switch (detected.kind) {
    case "url":
      if (detected.domain.includes("github.com") && /\/issues\/\d+/.test(detected.url)) {
        return { instruction: await fetchGitHubIssue(detected.url), source: detected.url };
      }
      return { instruction: await fetchWebPage(detected.url), source: detected.url };
    case "file":
      return { instruction: await Bun.file(detected.path).text(), source: detected.path };
    case "text":
      return { instruction: detected.text, source: "inline" };
  }
}
```

**Tests:**
- URL detection: `https://github.com/org/repo/issues/42` → url with github.com domain
- URL detection: `https://notion.so/page/abc` → url with notion.so domain
- File detection: `./task.md` (exists) → file
- Text detection: `"Fix the login bug"` → text
- GitHub issue fetch returns formatted markdown (mock `gh` CLI)
- Web page fetch returns readable content

### Step 2: Git Worktree Management

**File:** `src/git/worktree.ts`

```typescript
interface WorktreeInfo {
  repoPath: string;
  worktreePath: string;
  branch: string;
}

async function detectRepo(startDir: string): Promise<{ repoPath: string; remote: string; defaultBranch: string }> {
  // Walk up from startDir looking for .git/
  // Get remote URL: git remote get-url origin
  // Get default branch: git symbolic-ref refs/remotes/origin/HEAD
  // Return repo path, normalized remote, and default branch
}

async function createWorktree(
  repoPath: string,
  taskId: string,
  baseBranch: string
): Promise<WorktreeInfo> {
  // Branch name: deer/<taskId>
  // Worktree path: ~/.local/share/deer/tasks/<taskId>/worktree
  // mkdir -p the parent directory
  // git worktree add -b <branch> <worktreePath> <baseBranch>
  // Return info
}

async function finalizeWorktree(worktreePath: string): Promise<void> {
  // In worktree dir:
  // git add -A
  // git status --porcelain → if changes exist, commit
  // git push origin <branch>
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  // git worktree remove <worktreePath> --force
}
```

**File:** `src/git/sync.ts`

```typescript
// Cross-process file lock on .git/deer.lock
// Prevents concurrent deer processes from corrupting git state
// Uses Bun's file I/O + flock syscall

async function withGitLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(repoPath, '.git', 'deer.lock');
  // Open lock file, flock(LOCK_EX), run fn, flock(LOCK_UN), close
}
```

**Tests:**
- detectRepo finds .git walking up from subdirectory
- detectRepo errors when not in a git repo
- createWorktree creates directory and git worktree
- createWorktree branch name follows convention
- finalizeWorktree commits and pushes changes
- finalizeWorktree is a no-op when there are no changes
- removeWorktree cleans up worktree directory
- withGitLock serializes concurrent operations (race condition test)

### Step 3: Network Isolation

**File:** `src/container/network.ts`

```typescript
interface NetworkSetup {
  networkName: string;
  proxyContainerId: string;
  cleanup: () => Promise<void>;
}

async function ensureProxyContainer(
  docker: Dockerode,
  allowlist: string[]
): Promise<string> {
  // Check if deer-proxy container exists and is running
  // If not, create it:
  //   - Image: ubuntu/squid (or custom image with squid + iptables)
  //   - Generate squid.conf with allowlisted domains
  //   - Start container
  // Return container ID
}

async function createTaskNetwork(
  docker: Dockerode,
  taskId: string,
  proxyContainerId: string
): Promise<NetworkSetup> {
  // Create internal Docker network: deer-net-<taskId>
  //   docker.createNetwork({ Name: ..., Internal: true })
  // Connect proxy container to this network
  // Return network info + cleanup function
}
```

**Squid config template:**

```
# Generated by deer — allowlisted domains only
http_port 3128

acl allowed_domains dstdomain .api.anthropic.com
acl allowed_domains dstdomain .statsig.anthropic.com
acl allowed_domains dstdomain .sentry.io
acl allowed_domains dstdomain .registry.npmjs.org
acl allowed_domains dstdomain .pypi.org
acl allowed_domains dstdomain .github.com
acl allowed_domains dstdomain .objects.githubusercontent.com
# ... per-repo additions ...

http_access allow allowed_domains
http_access deny all
```

**Tests:**
- ensureProxyContainer creates proxy on first call
- ensureProxyContainer reuses existing proxy on second call
- createTaskNetwork creates an internal Docker network
- Proxy container is connected to the task network
- Cleanup removes network and disconnects proxy

### Step 4: Boilerhouse Integration

#### 4.1 Boilerhouse API Client

**File:** `src/boilerhouse/client.ts`

```typescript
interface BoilerhouseClient {
  /** @example "http://localhost:3000" */
  readonly baseUrl: string;

  // Workloads
  createWorkload(spec: WorkloadSpecRaw): Promise<{ id: string }>;
  getWorkload(id: string): Promise<WorkloadSpecRaw | null>;
  deleteWorkload(id: string): Promise<void>;

  // Claims
  claim(tenantId: string, poolId: string, options?: {
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<ClaimResult>;
  release(tenantId: string): Promise<void>;

  // Exec
  exec(containerId: string, command: string[], options?: {
    env?: Array<{ name: string; value: string }>;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  execStream(containerId: string, command: string[], options?: {
    env?: Array<{ name: string; value: string }>;
  }): Promise<ExecStreamResult>;

  // Health
  ping(): Promise<boolean>;
}

interface ClaimResult {
  containerId: string;
  endpoints: {
    socket: string;
    host: string;
  };
  expiresAt?: string;
}

interface ExecStreamResult {
  /** SSE event stream: { type: "stdout" | "stderr" | "exit", data: string } */
  stream: ReadableStream<ServerSentEvent>;
}

function createBoilerhouseClient(baseUrl: string): BoilerhouseClient {
  // Implementation using fetch() — no HTTP library needed
  // All methods are thin wrappers around fetch() calls to boilerhouse REST API
  //
  // Endpoints:
  //   POST   /api/v1/workloads           → createWorkload
  //   GET    /api/v1/workloads/:id       → getWorkload
  //   DELETE /api/v1/workloads/:id       → deleteWorkload
  //   POST   /api/v1/tenants/:id/claim   → claim
  //   POST   /api/v1/tenants/:id/release → release
  //   POST   /api/v1/containers/:id/exec → exec
  //   POST   /api/v1/containers/:id/exec/stream → execStream (SSE)
  //   GET    /api/v1/health              → ping
}
```

#### 4.2 Devcontainer → WorkloadSpec Translation

**File:** `src/boilerhouse/workload.ts`

```typescript
interface DevcontainerConfig {
  image?: string;
  build?: { dockerfile?: string; context?: string };
  features?: Record<string, unknown>;
  runArgs?: string[];
  mounts?: string[];
  remoteEnv?: Record<string, string>;
  containerEnv?: Record<string, string>;
  postCreateCommand?: string | string[];
  postStartCommand?: string | string[];
  forwardPorts?: number[];
}

/**
 * Build a boilerhouse WorkloadSpec for a specific task.
 *
 * Creates a per-task workload with the devcontainer image, task worktree mount,
 * credential mounts, network config, and environment variables.
 */
function buildWorkloadSpec(options: {
  taskId: string;
  imageTag: string;
  worktreePath: string;
  networkName: string;
  credentialMounts: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
  env: Record<string, string>;
  setupCommand?: string;
}): WorkloadSpecRaw {
  const { taskId, imageTag, worktreePath, networkName, credentialMounts, env, setupCommand } = options;

  return {
    id: `deer-${taskId}`,
    name: `deer task ${taskId}`,
    image: imageTag,

    volumes: {
      custom: [
        // Task worktree
        {
          host_path: worktreePath,
          container_path: "/workspaces/repo",
          read_only: false,
        },
        // Credential mounts
        ...credentialMounts.map(m => ({
          host_path: m.hostPath,
          container_path: m.containerPath,
          read_only: m.readOnly,
        })),
      ],
    },

    environment: {
      DEER_TASK_ID: taskId,
      ...env,
    },

    networks: [networkName],

    pool: {
      min_idle: 0,     // cold-start: create on-demand
      max_size: 1,     // one container per task
      idle_timeout: "0s",
    },

    healthcheck: {
      test: ["CMD-SHELL", "echo ok"],
      interval: "10s",
      timeout: "5s",
      retries: 3,
      start_period: "5s",
    },

    // Setup command as post_claim hook
    ...(setupCommand ? {
      hooks: {
        post_claim: [{ command: ["sh", "-c", setupCommand] }],
      },
    } : {}),

    // Devcontainer images typically run as non-root user
    read_only: false,
  };
}

/**
 * Parse a devcontainer.json to extract the image name (for build) and
 * any runtime configuration.
 */
function parseDevcontainerConfig(worktreePath: string): Promise<DevcontainerConfig> {
  // Read .devcontainer/devcontainer.json or .devcontainer.json
  // Parse JSON (strip comments — devcontainer.json supports jsonc)
  // Return typed config
}
```

#### 4.3 Image Building

**File:** `src/container/image.ts`

```typescript
/**
 * Build a devcontainer image using the devcontainer CLI.
 * Returns the image tag. Caches by devcontainer.json content hash.
 */
async function buildDevcontainerImage(worktreePath: string): Promise<string> {
  const configHash = await hashDevcontainerConfig(worktreePath);
  const repoName = path.basename(worktreePath);
  const imageTag = `deer/${repoName}:${configHash}`;

  // Check if image already exists locally
  const docker = new Dockerode();
  try {
    await docker.getImage(imageTag).inspect();
    // Image exists, skip build
    return imageTag;
  } catch {
    // Image doesn't exist, build it
  }

  // devcontainer build --workspace-folder <worktreePath> --image-name <imageTag>
  const result = await Bun.$`devcontainer build --workspace-folder ${worktreePath} --image-name ${imageTag}`;
  if (result.exitCode !== 0) {
    throw new Error(`devcontainer build failed: ${result.stderr.toString()}`);
  }

  return imageTag;
}

/**
 * Hash the devcontainer config files to determine if a rebuild is needed.
 */
async function hashDevcontainerConfig(worktreePath: string): Promise<string> {
  // Hash: devcontainer.json + Dockerfile (if referenced) + any .devcontainer/ files
  // Return short hex hash (first 12 chars of SHA-256)
}
```

#### 4.4 Container Lifecycle

The container lifecycle is fully managed by boilerhouse. Deer's pipeline calls:

1. `client.createWorkload(spec)` — register the task's workload
2. `client.claim(taskId, poolId)` — pool creates container on-demand, waits for health check
3. `client.exec()` / `client.execStream()` — run commands in the container
4. `client.release(taskId)` — release the container (pool destroys it since idle_timeout=0)
5. `client.deleteWorkload(workloadId)` — clean up the workload + pool

**Tests:**
- BoilerhouseClient.ping() returns true when boilerhouse is running
- BoilerhouseClient.ping() returns false when boilerhouse is not running
- createWorkload sends valid WorkloadSpec and returns ID
- claim returns containerId and endpoints
- exec returns stdout/stderr/exitCode
- execStream returns SSE event stream with stdout/stderr/exit events
- release succeeds after claim
- deleteWorkload removes the workload
- buildWorkloadSpec includes all custom volumes (worktree + credentials)
- buildWorkloadSpec includes network and environment
- buildWorkloadSpec includes post_claim hook when setupCommand is set
- buildDevcontainerImage caches by config hash (second call is a no-op)
- buildDevcontainerImage builds when image doesn't exist
- parseDevcontainerConfig handles jsonc (comments in devcontainer.json)

### Step 5: Agent Invocation

**File:** `src/agent/types.ts`

```typescript
interface Agent {
  /** Validate that the agent CLI is available and authenticated */
  validate(): Promise<void>;

  /** Build the command to run inside the container */
  buildCommand(instructionPath: string): string[];

  /** Credential mounts needed inside the container */
  credentialMounts(): Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;

  /** Environment variables needed at exec time (per-exec, not baked into container) */
  execEnv(): Array<{ name: string; value: string }>;
}
```

**File:** `src/agent/claude.ts`

```typescript
const claudeAgent: Agent = {
  async validate() {
    // Run: claude auth status
    // If not authenticated, throw with instructions
  },

  buildCommand(instructionPath: string) {
    return [
      "sh", "-c",
      `cat ${instructionPath} | claude -p --dangerously-skip-permissions --verbose --output-format stream-json 2>&1`
    ];
  },

  credentialMounts() {
    const home = process.env.HOME!;
    return [
      { hostPath: `${home}/.claude`, containerPath: "/home/vscode/.claude", readOnly: true },
      { hostPath: `${home}/.claude.json`, containerPath: "/home/vscode/.claude.json", readOnly: true },
    ];
  },

  execEnv() {
    return [];  // Claude uses mounted config, not env vars
  },
};
```

**Tests:**
- validate() succeeds when claude is authenticated
- validate() throws descriptive error when not authenticated
- buildCommand produces correct shell invocation
- credentialMounts returns correct paths with expanded $HOME

### Step 6: PR Creation

**File:** `src/pr.ts`

```typescript
interface PRResult {
  url: string;
  number: number;
}

async function createPR(
  worktreePath: string,
  task: Task,
): Promise<PRResult> {
  // Generate title from instruction (first line, truncated to 70 chars)
  // Build body from template:
  //   ## Task
  //   {instruction or link to source}
  //   ## Changes
  //   {git diff --stat summary}
  //   ---
  //   *Generated by deer using Claude Code*

  // Shell out:
  //   gh pr create \
  //     --title "<title>" \
  //     --body "<body>" \
  //     --head <branch> \
  //     --base <baseBranch> \
  //     --assignee @me

  // Parse PR URL and number from gh output
  // Return result
}
```

**Tests:**
- PR title is truncated to 70 characters
- PR body includes task description and diff stats
- PR is assigned to current user
- Function returns PR URL and number

### Step 7: Pipeline Orchestrator

**File:** `src/pipeline.ts`

This wires everything together into the end-to-end flow.

```typescript
async function executePipeline(task: Task, config: DeerConfig): Promise<PRResult> {
  const docker = new Dockerode();
  const bh = createBoilerhouseClient(config.boilerhouse.url);
  const agent = claudeAgent;

  // Verify boilerhouse is reachable
  if (!await bh.ping()) {
    throw new Error(
      "Boilerhouse is not running. Start it with: cd <boilerhouse-dir> && bun run dev"
    );
  }

  // 1. Create worktree
  const worktree = await withGitLock(task.repo, () =>
    createWorktree(task.repo, task.id, task.baseBranch)
  );

  try {
    // 2. Build devcontainer image (cached by config hash)
    const imageTag = await buildDevcontainerImage(worktree.worktreePath);

    // 3. Set up network isolation
    const network = await createTaskNetwork(
      docker, task.id,
      await ensureProxyContainer(docker, task.networkAllowlist)
    );

    try {
      // 4. Register per-task workload in boilerhouse
      const workloadSpec = buildWorkloadSpec({
        taskId: task.id,
        imageTag,
        worktreePath: worktree.worktreePath,
        networkName: network.networkName,
        credentialMounts: agent.credentialMounts(),
        env: {
          ...task.env,
          HTTP_PROXY: "http://deer-proxy:3128",
          HTTPS_PROXY: "http://deer-proxy:3128",
        },
        setupCommand: task.setupCommand,
      });

      await bh.createWorkload(workloadSpec);
      const poolId = `deer-${task.id}`;  // pool ID matches workload ID

      try {
        // 5. Claim container (pool creates on-demand, waits for health check)
        const claim = await bh.claim(task.id, poolId, {
          timeoutMs: task.timeoutMs,
        });

        try {
          // 6. Write task instruction to file inside container
          const instructionPath = "/tmp/deer/task.md";
          await bh.exec(claim.containerId, ["mkdir", "-p", "/tmp/deer"]);
          await bh.exec(claim.containerId, [
            "sh", "-c",
            `cat > ${instructionPath} << 'DEER_EOF'\n${task.instruction}\nDEER_EOF`
          ]);

          // 7. Run agent (streaming output)
          const agentCmd = agent.buildCommand(instructionPath);
          const execEnv = agent.execEnv();
          const stream = await bh.execStream(claim.containerId, agentCmd, {
            env: execEnv,
          });

          // Stream SSE events to stdout
          for await (const event of stream.events) {
            if (event.type === "stdout" || event.type === "stderr") {
              process.stdout.write(event.data);
            } else if (event.type === "exit") {
              const exitCode = parseInt(event.data, 10);
              if (exitCode !== 0) {
                console.warn(`Agent exited with code ${exitCode}`);
              }
            }
          }

          // 8. Finalize git (commit + push)
          await withGitLock(task.repo, () =>
            finalizeWorktree(worktree.worktreePath)
          );

          // 9. Create PR (only if there are changes)
          const hasChanges = await worktreeHasChanges(worktree.worktreePath);
          if (hasChanges) {
            const pr = await createPR(worktree.worktreePath, task);
            return pr;
          } else {
            throw new Error("Agent produced no changes");
          }

        } finally {
          // Release container
          await bh.release(task.id).catch(console.error);
        }
      } finally {
        // Delete workload + pool
        await bh.deleteWorkload(workloadSpec.id).catch(console.error);
      }
    } finally {
      // Clean up network
      await network.cleanup().catch(console.error);
    }
  } finally {
    // Clean up worktree
    await withGitLock(task.repo, () =>
      removeWorktree(task.repo, worktree.worktreePath)
    ).catch(console.error);
  }
}
```

**Error handling:**
- Each `finally` block ensures cleanup runs even on failure
- Cleanup errors are caught and logged (don't mask the original error)
- Pipeline catches errors, sets `task.error`, and still cleans up
- If the agent fails (non-zero exit), deer still commits whatever changes exist and creates a draft PR noting the failure (or skips PR if no changes)

**Tests:**
- Full pipeline integration test (with mock boilerhouse + mock agent)
- Cleanup runs on success
- Cleanup runs on agent failure
- No PR created when agent produces no changes
- Setup command runs via boilerhouse post_claim hook
- Pipeline errors when boilerhouse is not running
- Network isolation is set up before container creation
- Workload is deleted on cleanup

### Step 8: CLI Entry Point

**File:** `src/cli.ts`

```typescript
#!/usr/bin/env bun

import { parseArgs } from "util";

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      env: { type: "string", multiple: true },  // KEY=VALUE pairs
      timeout: { type: "string" },              // e.g. "30m", "1h"
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  // Get task input
  let taskInput: string;
  if (positionals.length > 0) {
    taskInput = positionals.join(" ");
  } else {
    // Interactive mode: prompt for input
    taskInput = await promptForInput();
  }

  // Detect repo
  const repo = values.repo
    ? await detectRepo(values.repo)
    : await detectRepo(process.cwd());

  // Load config
  const config = await loadConfig(repo.repoPath);

  // Resolve task instruction
  const { instruction, source } = await resolveInstruction(taskInput);

  // Parse env overrides from CLI
  const cliEnv = parseEnvArgs(values.env ?? []);

  // Parse timeout
  const timeoutMs = values.timeout
    ? parseTimeout(values.timeout)
    : config.defaults.timeoutMs ?? 1800000;

  // Build task
  const task: Task = {
    id: generateTaskId(),
    status: "pending",
    repo: repo.repoPath,
    repoRemote: repo.remote,
    baseBranch: config.baseBranch ?? repo.defaultBranch,
    workBranch: `deer/${task.id}`,
    worktreePath: `${dataDir()}/tasks/${task.id}/worktree`,
    instruction,
    instructionSource: source,
    env: { ...config.env, ...cliEnv },
    networkAllowlist: [...config.network.allowlist, ...(config.networkAllowlistExtra ?? [])],
    timeoutMs,
    setupCommand: config.setupCommand,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    prUrl: null,
    error: null,
  };

  // Validate prerequisites
  await claudeAgent.validate();
  await validateGhCli();
  await validateDocker();
  await validateDevcontainerCli();

  if (values["dry-run"]) {
    console.log("Dry run — would execute task:");
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  // Execute
  console.log(`Starting task ${task.id}...`);
  console.log(`Repo: ${task.repoRemote}`);
  console.log(`Branch: ${task.workBranch}`);
  console.log(`Task: ${task.instructionSource}`);

  const pr = await executePipeline(task, config);

  console.log(`\nPR created: ${pr.url}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

**Tests:**
- `--help` prints usage
- `--dry-run` prints task without executing
- Positional arg is used as task input
- `--repo` overrides cwd detection
- `--env KEY=VALUE` adds env vars
- `--timeout 30m` sets timeout in milliseconds
- Missing repo errors with helpful message
- Missing claude auth errors with helpful message

---

## Implementation Order

```
Step 0: Project scaffolding              [0.5 day]
  - bun init, tsconfig, directory structure
  - Config types + TOML loading
  - Task model + ID generation

Step 1: Task input detection             [0.5 day]
  - detect.ts: URL/file/text detection
  - github.ts: GitHub issue fetcher
  - web.ts: generic URL fetcher
  - Tests for all

Step 2: Git worktree management          [1 day]
  - worktree.ts: create/finalize/remove
  - sync.ts: flock-based locking
  - Tests with real git repos (tmpdir fixtures)

Step 3: Network isolation                [1 day]
  - network.ts: Squid proxy container + internal networks
  - Squid config generation
  - Tests with real Docker (integration tests)

Step 4: Boilerhouse integration          [1.5 days]
  - client.ts: typed HTTP client for boilerhouse REST API
  - workload.ts: devcontainer.json → WorkloadSpec translation
  - image.ts: devcontainer build wrapper with caching
  - Tests (mock HTTP for unit, real boilerhouse for integration)

Step 5: Agent invocation                 [0.5 day]
  - claude.ts: validate, command construction, credential mounts
  - Tests (mock agent for unit)

Step 6: PR creation                      [0.5 day]
  - pr.ts: title generation, body template, gh CLI wrapper
  - Tests (mock gh CLI)

Step 7: Pipeline orchestrator            [1 day]
  - pipeline.ts: wire everything together via boilerhouse
  - Error handling + cleanup
  - Integration tests with mock components

Step 8: CLI entry point                  [0.5 day]
  - cli.ts: arg parsing, interactive mode, dry-run
  - End-to-end manual testing with real repo

Total: ~7 days of focused implementation
```

Boilerhouse P0 changes can be implemented in parallel with Steps 0-3 (they share no code). Steps 4+ depend on the boilerhouse changes being available.

---

## Testing Strategy

**Unit tests** (fast, no Docker, no boilerhouse):
- Task input detection
- Config parsing
- Task ID generation
- Git worktree operations (with tmpdir git repos)
- WorkloadSpec generation
- PR body/title generation
- Agent command construction
- Boilerhouse client (mock HTTP responses)

**Integration tests** (require Docker + boilerhouse):
- Network isolation (proxy blocks unauthorized domains)
- Boilerhouse workload lifecycle (create → claim → exec → release → delete)
- Devcontainer image building + caching
- Full pipeline with a minimal test repo

**End-to-end test** (manual, against MeetsMore monorepo):
- Run `deer "Add a health check endpoint to the internal API"` in the MeetsMore repo
- Verify: worktree created, image built, workload registered, container claimed, agent ran, PR opened, cleanup completed

---

## Validation Criteria

Phase 1 is complete when:

1. `deer "Fix bug X"` in a repo with `.devcontainer/` creates a PR
2. Container lifecycle is managed by boilerhouse (not devcontainer CLI)
3. The agent runs inside a network-isolated container (only allowlisted domains reachable)
4. The worktree is created, used, and cleaned up properly
5. The boilerhouse workload is created and deleted per task
6. The PR is created with a descriptive body and assigned to the invoking user
7. `deer --dry-run "task"` prints the task plan without executing
8. GitHub issue URLs are fetched and used as task instructions
9. Config from `~/.config/deer/config.toml` and `deer.toml` is respected
10. Prerequisites are validated with clear error messages before any work begins
11. All unit tests pass
12. Integration tests with Docker + boilerhouse pass
