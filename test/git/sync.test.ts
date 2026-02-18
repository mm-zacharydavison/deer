import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { withGitLock } from "../../src/git/sync";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("withGitLock", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-lock-test-"));
    // Create a fake .git directory
    await mkdir(join(tmpDir, ".git"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("executes the function and returns its result", async () => {
    const result = await withGitLock(tmpDir, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test("propagates errors from the inner function", async () => {
    expect(
      withGitLock(tmpDir, async () => {
        throw new Error("inner error");
      })
    ).rejects.toThrow("inner error");
  });

  test("serializes concurrent operations", async () => {
    const order: number[] = [];

    const task1 = withGitLock(tmpDir, async () => {
      order.push(1);
      // Simulate work
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
    });

    const task2 = withGitLock(tmpDir, async () => {
      order.push(3);
      await new Promise((r) => setTimeout(r, 10));
      order.push(4);
    });

    await Promise.all([task1, task2]);

    // Tasks should not interleave: either [1,2,3,4] or [3,4,1,2]
    const valid =
      (order[0] === 1 && order[1] === 2 && order[2] === 3 && order[3] === 4) ||
      (order[0] === 3 && order[1] === 4 && order[2] === 1 && order[3] === 2);
    expect(valid).toBe(true);
  });

  test("releases lock even if function throws", async () => {
    try {
      await withGitLock(tmpDir, async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }

    // Should be able to acquire the lock again
    const result = await withGitLock(tmpDir, async () => "ok");
    expect(result).toBe("ok");
  });
});
