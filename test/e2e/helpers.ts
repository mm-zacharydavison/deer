import * as pty from "node-pty";
import { Terminal } from "@xterm/headless";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataDir } from "../../src/task";

// ── Types ─────────────────────────────────────────────────────────────

export interface DeerSession {
  /** Write keystrokes to the PTY. Use "\r" for Enter, "\x7f" for Backspace. */
  sendKeys: (keys: string) => void;
  /** Poll the screen buffer until any row contains text, or throw on timeout. */
  waitForPane: (text: string, timeoutMs?: number) => Promise<void>;
  /** Returns the current screen contents as an array of rows (flushes pending writes). */
  getScreen: () => Promise<string[]>;
  /** Kill the PTY process and clean up. */
  stop: () => Promise<void>;
}

// ── Polling helper ────────────────────────────────────────────────────

/** Poll until condition() returns truthy, or throw on timeout. */
export async function waitFor(
  condition: () => Promise<boolean | string | null | undefined>,
  {
    timeout = 15_000,
    interval = 250,
    label = "condition",
  }: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(interval);
  }
  throw new Error(`waitFor("${label}") timed out after ${timeout}ms`);
}

// ── Session management ────────────────────────────────────────────────

/**
 * Spawn deer TUI in a real PTY using node-pty + @xterm/headless.
 * The xterm Terminal interprets VT100/ANSI sequences from the PTY output
 * and maintains a virtual screen buffer that can be queried like a DOM.
 *
 * Optionally pass a custom command to run instead of `bun run src/cli.tsx`
 * (e.g. for the build-smoke test which uses the compiled binary).
 */
export async function startDeerSession(
  repoPath: string,
  extraEnv: Record<string, string> = {},
  options: { command?: string[] } = {},
): Promise<DeerSession> {
  const cols = 120;
  const rows = 40;
  const term = new Terminal({ cols, rows, allowProposedApi: true });

  const command =
    options.command ?? ["bun", "run", join(import.meta.dir, "../../src/cli.tsx")];
  const [file, ...args] = command;

  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: repoPath,
    env: { ...process.env, ...extraEnv } as Record<string, string>,
  });

  // Track pending writes so getScreen() always reflects the latest output.
  let writeChain = Promise.resolve();
  proc.onData((data) => {
    writeChain = writeChain.then(
      () => new Promise<void>((resolve) => term.write(data, resolve)),
    );
  });

  function readBuffer(): string[] {
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
        async () => {
          await writeChain;
          return readBuffer().some((l) => l.includes(text));
        },
        { timeout: timeoutMs, label: `pane contains "${text}"` },
      ),

    getScreen: async () => {
      await writeChain;
      return readBuffer();
    },

    stop: async () => {
      proc.kill();
    },
  };
}

// ── Repo helpers ──────────────────────────────────────────────────────

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
  await Bun.$`git -C ${dir} add -A`.quiet();
  await Bun.$`git -C ${dir} commit -m "init"`.quiet();
  await Bun.$`git -C ${dir} branch -M main`.quiet();
  return {
    repoPath: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ── Fake claude helpers ───────────────────────────────────────────────

/**
 * Run a test with a fast fake claude binary prepended to PATH.
 * The fake claude prints some output and exits after ~1 second.
 */
export async function withFakeClaude<T>(
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
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

/**
 * Run a test with a slow fake claude binary prepended to PATH.
 * The fake claude sleeps for 60 seconds — suitable for kill/cancel action tests.
 */
export async function withSlowFakeClaude<T>(
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "deer-e2e-bin-"));
  const fakeBin = join(binDir, "claude");
  const stubSrc = join(import.meta.dir, "../fixtures/fake-claude-slow.sh");
  await Bun.$`cp ${stubSrc} ${fakeBin} && chmod +x ${fakeBin}`.quiet();
  try {
    return await fn({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

// ── Task discovery ────────────────────────────────────────────────────

/**
 * Scan dataDir/tasks/ for a taskId directory created after a given timestamp.
 * Returns the taskId of the first matching directory found.
 */
export async function waitForNewTaskDir(
  since: number,
  timeoutMs = 15_000,
): Promise<string> {
  const tasksDir = join(dataDir(), "tasks");
  let found: string | undefined;
  await waitFor(
    async () => {
      let entries: string[];
      try {
        entries = await readdir(tasksDir);
      } catch {
        return false;
      }
      found = (
        await Promise.all(
          entries
            .filter((e) => e.startsWith("deer_"))
            .map(async (e) => {
              const s = await stat(join(tasksDir, e)).catch(() => null);
              return s && s.ctimeMs > since ? e : null;
            }),
        )
      ).find((e): e is string => e !== null);
      return !!found;
    },
    { timeout: timeoutMs, label: "new task directory" },
  );
  return found!;
}
