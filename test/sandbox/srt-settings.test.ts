/**
 * Tests that srt-settings.json allows writes to the repo's .git directory,
 * which is needed for git operations in worktrees.
 *
 * Git worktrees share objects, refs, and packed-refs with the main repo.
 * The sandbox must allow writes to the entire .git/ directory so git add
 * (objects), commit (refs), and worktree metadata operations all succeed.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { createSrtRuntime } from "../../packages/deerbox/src/index";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("srt settings - repo .git write permission", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "deer-srt-test-"));
    tmpDirs.push(d);
    return d;
  }

  test("repoGitDir is included in allowWrite when provided", async () => {
    const repoGitDir = await makeTmpDir();
    await mkdir(join(repoGitDir, "objects"), { recursive: true });

    const worktreeDir = await makeTmpDir();

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      repoGitDir,
      allowlist: [],
    });

    const settingsPath = join(worktreeDir, "..", "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).toContain(repoGitDir);
  });

  test("allowWrite has no repoGitDir when it is not provided", async () => {
    const worktreeDir = await makeTmpDir();

    const runtime = createSrtRuntime();
    await runtime.prepare?.({
      worktreePath: worktreeDir,
      allowlist: [],
    });

    const settingsPath = join(worktreeDir, "..", "srt-settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const allowWrite: string[] = settings.filesystem.allowWrite;

    expect(allowWrite).toContain(worktreeDir);
    // No extra paths beyond defaults
    const extraPaths = allowWrite.filter(
      (p) =>
        p !== worktreeDir &&
        !p.includes(".claude") &&
        p !== "/tmp" &&
        p !== "/private/tmp"
    );
    expect(extraPaths).toHaveLength(0);
  });
});
