---
nav_exclude: true
---

# E2E Test Plan for deer

This document describes the E2E test suite to be built for deer. The goal is to catch real-world integration bugs that only surface when running actual deer — things like the TUI not rendering correctly, state sync failing between instances, or the full agent lifecycle breaking.

## Background: What Unit Tests Don't Catch

The current unit tests cover individual modules well (state machine, task persistence, config parsing, sandbox launch). But the bugs that keep recurring are at the integration seams:

- The TUI renders nothing or the wrong thing after state changes
- The dashboard doesn't pick up a state file written by a running agent
- A task appears stuck/running after deer is restarted
- Keyboard actions (kill, delete, retry) silently fail
- The bypass dialog isn't dismissed, so Claude hangs waiting for input
- Worktrees or tmux sessions are left behind after a crash

E2E tests close these gaps by running the actual `bun src/cli.tsx` binary and verifying both **TUI output** and **filesystem state**.

## Approach

### TUI capture via node-pty + @xterm/headless

The test driver spawns deer in a real PTY using `node-pty`, and interprets the rendered output using `@xterm/headless` — the headless mode of xterm.js. This avoids tmux-in-tmux, which behaves differently from a real terminal and introduces session multiplexing quirks in the outer test driver.

```
test process
  └─ node-pty (real PTY)
       └─ bun src/cli.tsx   ← deer TUI renders here
            └─ @xterm/headless terminal buffer (VT100 interpreter)
                 └─ [user spawns a task]
                      └─ tmux session: deer-<taskId>   ← Claude runs here (unchanged)
```

This means:
- The TUI is a real Ink render inside a real PTY
- Keystrokes are written directly to the PTY (`pty.write(...)`)
- Screen state is queried from `terminal.buffer.active` (row by row, like a DOM)
- Inner agent tmux sessions are unaffected — deer still manages these exactly as in production

### Waiting for expected state

Use a poll helper rather than fixed sleeps:

```typescript
async function waitFor(
  condition: () => Promise<boolean>,
  { timeout = 15_000, interval = 200 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(interval);
  }
  throw new Error("waitFor timed out");
}
```

### Fake Claude stub

Most E2E tests should NOT call real Claude. Instead, use a fake `claude` script that:
- Prints some plausible output to stdout
- Exits with 0 after a short delay

Location: `test/fixtures/fake-claude.sh`

```bash
#!/bin/sh
# Fake claude stub for E2E tests.
# Simulates a brief run and exits successfully.
sleep 1
echo "● Applying the fix"
sleep 1
echo "● Done"
exit 0
```

The test harness injects this by prepending a temp dir containing a `claude` symlink to `PATH` before launching deer.

### Test helper module

Create `test/e2e/helpers.ts` with shared utilities:

```typescript
export async function startDeerSession(repoPath: string, extraEnv?: Record<string, string>): Promise<{
  /** Write keystrokes to the PTY. */
  sendKeys: (keys: string) => void;
  /** Poll screen buffer until any row contains text, or throw on timeout. */
  waitForPane: (text: string, timeoutMs?: number) => Promise<void>;
  /** Current screen contents as an array of rows. */
  getScreen: () => string[];
  /** Kill the PTY process and clean up. */
  stop: () => Promise<void>;
}>

export async function createTestRepo(): Promise<{ repoPath: string; cleanup: () => Promise<void> }>

export async function withFakeClaude<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T>
```

---

## Test Files

### `test/e2e/cli-startup.test.ts`

**Purpose:** Verify deer launches, renders the TUI, and exits cleanly.

**Test: renders dashboard header in a git repo**
```
1. createTestRepo()
2. const deer = await startDeerSession(repoPath)
3. await deer.waitForPane("deer") — any identifying header text
4. deer.sendKeys("q") — quit
5. await deer.stop()
```

**Test: exits with error when not in a git repo**
```
1. Run `bun src/cli.tsx` in /tmp (not a git repo) as a subprocess (no PTY needed)
2. Capture stderr/stdout
3. Expect process.exited !== 0
4. Expect output contains "Error"
```

**Test: preflight error shown in TUI when claude is missing**
```
1. createTestRepo()
2. const deer = await startDeerSession(repoPath, { PATH: pathWithoutClaude })
3. await deer.waitForPane("claude CLI not available")
4. await deer.stop()
```

**Test: preflight shows credential type**
```
1. createTestRepo()
2. const deer = await startDeerSession(repoPath, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" })
3. await deer.waitForPane("subscription")  — or whatever label is shown
4. await deer.stop()
```

---

### `test/e2e/agent-lifecycle.test.ts`

**Purpose:** Verify the full path from prompt submission to completion. This is the most important E2E test — it catches the most regressions.

**Test: submitting a prompt creates a worktree and tmux session**
```
1. createTestRepo()
2. withFakeClaude(async (env) => {
3.   const deer = await startDeerSession(repoPath, env)
4.   await deer.waitForPane("deer")  — TUI is up
5.   deer.sendKeys("fix the bug\r")
6.   const taskId = await waitForNewTaskDir(Date.now())
7.     — scan dataDir/tasks/ for new dirs since test started
8.   Verify state.json has status: "running"
9.   Verify tmux session deer-<taskId> exists (isTmuxSessionDead returns false)
10.  waitFor(() => isTmuxSessionDead(`deer-${taskId}`))  — fake claude finishes
11.  waitFor(() => loadHistory(repoPath) has an entry for this prompt)
12.  Verify history entry status is not "running" (completed, cancelled, or failed)
13.  await deer.stop()
14. })
```

**Test: state.json is removed after agent completes**
```
After the agent's tmux session dies and deer processes it:
- Verify state.json is gone (the JSONL history is now authoritative)
```

**Test: worktree directory exists while agent is running**
```
After prompt submission, before fake claude exits:
- Verify dataDir/tasks/<taskId>/worktree/.git exists
```

**Implementation note on taskId discovery:** Because the TUI doesn't print the taskId to the pane, scan `dataDir()/tasks/` for directories created after the test started:
```typescript
async function waitForNewTaskId(since: number): Promise<string> {
  return waitFor(async () => {
    const entries = await readdir(join(dataDir(), "tasks"));
    return entries.find(e => e.startsWith("deer_") && statSync(join(dataDir(), "tasks", e)).ctimeMs > since);
  });
}
```

---

### `test/e2e/keyboard-actions.test.ts`

**Purpose:** Verify keyboard actions (kill, delete, retry) actually work end-to-end.

**Test: 'x' kills a running agent**
```
1. const deer = await startDeerSession(repoPath, env)  — long-running fake claude (sleep 60)
2. Wait for agent tmux session to appear
3. The running task should be selected by default
4. deer.sendKeys("x")   — kill action
5. await deer.waitForPane("Cancel")  — confirmation prompt appears
6. deer.sendKeys("y")  — confirm
7. waitFor(() => isTmuxSessionDead(`deer-<taskId>`))
8. await deer.waitForPane("cancelled")
9. Verify history has status: "cancelled"
10. await deer.stop()
```

**Test: Backspace/Delete removes a completed task**
```
1. const deer = await startDeerSession(repoPath, env)  — fast fake claude
2. Wait for agent to complete
3. deer.sendKeys("\x7f")  — Backspace
4. waitFor(() => !Bun.file(join(dataDir(), "tasks", taskId, "state.json")).exists())
5. Verify JSONL history no longer has this taskId
6. Verify worktree directory is gone
7. Verify deer.getScreen() no longer contains the taskId
8. await deer.stop()
```

**Test: 'r' retries a completed task using --continue**
```
1. const deer = await startDeerSession(repoPath, env)  — fast fake claude
2. Wait for completion
3. deer.sendKeys("r")  — retry
4. waitFor(() => new tmux session for same taskId exists)
5. Verify session name is deer-<same taskId>
6. Verify worktree path is same as before (--continue reuses it)
7. await deer.stop()
```

---

### `test/e2e/multi-instance.test.ts`

**Purpose:** Verify that tasks from a second deer instance appear correctly in the first instance's dashboard.

**Test: task from another instance appears as running**
```
1. createTestRepo()
2. const deer = await startDeerSession(repoPath)
3. Directly write a state.json into dataDir/tasks/<fakeTaskId>/state.json
   with ownerPid = process.pid (so isOwnerAlive returns true)
   and status = "running"
4. await deer.waitForPane(fakeTaskId's prompt)
5. Verify deer.getScreen() shows the task as "running"
6. await deer.stop()
```

**Test: task becomes interrupted when owning process dies**
```
1. const deer = await startDeerSession(repoPath)
2. Write state.json with ownerPid = a PID that doesn't exist (e.g. 99999999)
3. await deer.waitForPane("interrupted")  — or task disappears
4. await deer.stop()
```

**Implementation note:** The multi-instance sync is driven by `fs.watch` + a safety poll (every 10s, `TASK_SYNC_SAFETY_POLL_MS`). Tests should write the state file and then wait up to ~15s for the sync to fire. The test can alternatively trigger the watch event by writing to the watched directory.

---

### `test/e2e/state-sync.test.ts`

**Purpose:** Verify the state sync pipeline (state files → agent list) without needing the full TUI. This is faster and more deterministic than TUI-level tests.

These tests call the sync logic directly:

```typescript
import { scanLiveTaskIds } from "../../src/task-state";
import { readTaskState } from "../../src/task-state";
import { loadHistory } from "../../src/task";
import { liveTaskFromStateFile, historicalAgentFromStateFile } from "../../src/agent-state";
import { isOwnerAlive } from "../../src/task-state";
```

**Test: live state file with alive owner → liveTaskFromStateFile**
```
1. Write state.json with ownerPid = process.pid, status = "running"
2. scanLiveTaskIds() includes the taskId
3. readTaskState(taskId) returns the state
4. isOwnerAlive(state.ownerPid) === true
5. liveTaskFromStateFile(state).status === "running"
6. liveTaskFromStateFile(state).historical === true
Cleanup: removeTaskState(taskId)
```

**Test: state file with dead owner → historicalAgentFromStateFile**
```
1. Write state.json with ownerPid = 99999999 (dead), status = "running"
2. readTaskState(taskId) returns state
3. isOwnerAlive(state.ownerPid) === false
4. historicalAgentFromStateFile(state).status === "interrupted"
5. historicalAgentFromStateFile(state).lastActivity === "Interrupted — deer was closed"
Cleanup: removeTaskState(taskId)
```

**Test: deleted taskId is excluded from sync results**
```
1. Write state.json for taskId
2. scanLiveTaskIds() includes taskId
3. Add taskId to a Set<string> (simulating deletedTaskIdsRef)
4. Filter: liveTaskIds.filter(id => !deleted.has(id)) — taskId excluded
```

**Test: JSONL history entry used as fallback when no state file**
```
1. upsertHistory(repoPath, { taskId, status: "cancelled", ... })
2. No state.json written
3. loadHistory(repoPath) returns the task
4. historicalAgent(task).status === "cancelled"
Cleanup: removeFromHistory(repoPath, taskId)
```

**Test: state file takes priority over JSONL history for running tasks**
```
1. upsertHistory(repoPath, { taskId, status: "running", ... })  — stale JSONL entry
2. writeTaskState({ taskId, ownerPid: process.pid, status: "running", ... })
3. isOwnerAlive(process.pid) === true → use liveTaskFromStateFile
4. Result status is "running" (from state file, not from JSONL)
Cleanup: removeTaskState + removeFromHistory
```

---

### `test/e2e/build-smoke.test.ts`

**Purpose:** Verify the compiled binary works (prevents broken releases).

**Test: binary exits with error when not in a git repo**
```
1. Run dist/deer-darwin-arm64 (or appropriate platform binary) in /tmp
2. Expect exit code != 0
3. Expect stderr contains "Error"
```

**Test: binary produces no startup crash in a git repo**
```
1. createTestRepo()
2. const deer = await startDeerSession(repoPath)  — using the binary, not bun src/cli.tsx
3. await deer.waitForPane("deer")  — TUI rendered without crash
4. deer.sendKeys("q")
5. await deer.stop()
```

**Note:** This test should only run when `dist/` exists. Skip with `test.skip` when no binary is present, or gate on `DEER_BINARY_PATH` env var.

---

## Infrastructure Needed

### Dev dependencies

```sh
bun add -d node-pty @xterm/headless
```

`node-pty` is a native addon — it requires build tools (`python3`, `make`, a C++ compiler) at install time. These are standard in most CI environments. The compiled `.node` file is placed in `node_modules/node-pty/build/`.

### `test/fixtures/fake-claude.sh`

```bash
#!/bin/sh
# Fake claude stub for E2E tests.
# Accepts any arguments (like the real claude binary) and exits quickly.
echo "Claude Code 1.0.0 (fake)"
sleep 0.5
echo "● Implementing the task..."
sleep 0.5
echo "● Done. Changes committed."
exit 0
```

Make executable (`chmod +x`) and reference from `withFakeClaude`.

### `test/e2e/helpers.ts`

Key utilities:

```typescript
import * as pty from "node-pty";
import { Terminal } from "@xterm/headless";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataDir } from "../../src/task";

/** Poll until condition() returns truthy, or throw on timeout. */
export async function waitFor(
  condition: () => Promise<boolean | string | null | undefined>,
  { timeout = 15_000, interval = 250, label = "condition" }: {
    timeout?: number;
    interval?: number;
    label?: string;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(interval);
  }
  throw new Error(`waitFor("${label}") timed out after ${timeout}ms`);
}

/** Spawn deer TUI in a PTY. Returns controls for the session. */
export async function startDeerSession(
  repoPath: string,
  extraEnv: Record<string, string> = {},
): Promise<{
  sendKeys: (keys: string) => void;
  waitForPane: (text: string, timeoutMs?: number) => Promise<void>;
  getScreen: () => string[];
  stop: () => Promise<void>;
}> {
  const cols = 120;
  const rows = 40;
  const term = new Terminal({ cols, rows, allowProposedApi: true });

  const proc = pty.spawn("bun", ["run", join(import.meta.dir, "../../src/cli.tsx")], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: repoPath,
    env: { ...process.env, ...extraEnv } as Record<string, string>,
  });

  proc.onData(data => term.write(data));

  function getScreen(): string[] {
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
    }
    return lines;
  }

  return {
    sendKeys: (keys: string) => proc.write(keys),

    waitForPane: (text: string, timeoutMs = 15_000) =>
      waitFor(
        async () => getScreen().some(l => l.includes(text)),
        { timeout: timeoutMs, label: `pane contains "${text}"` },
      ),

    getScreen,

    stop: async () => {
      proc.kill();
    },
  };
}

/** Create a minimal git repo suitable for E2E tests. */
export async function createTestRepo(): Promise<{
  repoPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "deer-e2e-"));
  await Bun.$`git init ${dir}`.quiet();
  await Bun.$`git -C ${dir} config user.name "deer-e2e"`.quiet();
  await Bun.$`git -C ${dir} config user.email "e2e@deer.test"`.quiet();
  await Bun.write(join(dir, "README.md"), "# E2E Test Repo\n");
  await Bun.$`git -C ${dir} add -A && git -C ${dir} commit -m "init"`.quiet();
  await Bun.$`git -C ${dir} branch -M main`.quiet();
  return {
    repoPath: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Run a test with a fake claude binary prepended to PATH. */
export async function withFakeClaude<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "deer-e2e-bin-"));
  const fakeBin = join(binDir, "claude");
  const stubSrc = join(import.meta.dir, "../fixtures/fake-claude.sh");
  await Bun.$`cp ${stubSrc} ${fakeBin} && chmod +x ${fakeBin}`.quiet();
  try {
    return await fn({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

/** Scan dataDir/tasks/ for a taskId dir created after a given timestamp. */
export async function waitForNewTaskDir(since: number, timeoutMs = 15_000): Promise<string> {
  const tasksDir = join(dataDir(), "tasks");
  let found: string | undefined;
  await waitFor(
    async () => {
      let entries: string[];
      try { entries = await readdir(tasksDir); } catch { return false; }
      found = (await Promise.all(
        entries
          .filter(e => e.startsWith("deer_"))
          .map(async e => {
            const s = await stat(join(tasksDir, e)).catch(() => null);
            return s && s.ctimeMs > since ? e : null;
          }),
      )).find((e): e is string => e !== null);
      return !!found;
    },
    { timeout: timeoutMs, label: "new task directory" },
  );
  return found!;
}
```

---

## Running E2E Tests

E2E tests are slow (30–60s each) and have external dependencies (tmux, bun, git). They should be in a separate suite from unit tests:

```sh
# Unit tests only (fast, CI default)
bun test test/*.test.ts test/**/*.test.ts

# E2E tests (slow, opt-in)
DEER_E2E=1 bun test test/e2e/*.test.ts
```

Gate E2E tests with an env var check:

```typescript
import { describe, test } from "bun:test";

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("CLI startup", () => {
  // ...
});
```

Or use `setDefaultTimeout(60_000)` at the top of each E2E test file and skip whole files if the env var is absent.

---

## Implementation Order

1. **`test/fixtures/fake-claude.sh`** — unblocks all lifecycle tests
2. **`test/e2e/helpers.ts`** — shared infrastructure, written once
3. **`test/e2e/state-sync.test.ts`** — no TUI needed, pure filesystem; catches the most common cross-instance bugs
4. **`test/e2e/cli-startup.test.ts`** — verifies TUI boots and quits cleanly
5. **`test/e2e/agent-lifecycle.test.ts`** — full lifecycle, highest regression value
6. **`test/e2e/keyboard-actions.test.ts`** — catch action bugs (kill/delete/retry)
7. **`test/e2e/multi-instance.test.ts`** — cross-instance sync
8. **`test/e2e/build-smoke.test.ts`** — add last, after release pipeline is stable
