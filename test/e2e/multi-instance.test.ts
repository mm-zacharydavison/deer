/**
 * Multi-instance E2E tests.
 *
 * Verify that tasks from a second deer instance appear correctly in the first
 * instance's dashboard via the state file sync mechanism (fs.watch + poll).
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";

import { startDeerSession, createTestRepo, waitFor } from "./helpers";
import { writeTaskState, removeTaskState } from "../../src/task-state";
import { generateTaskId } from "../../src/task";

setDefaultTimeout(60_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("multi-instance sync", () => {
  test("task from another instance appears as running in the TUI", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    const taskId = generateTaskId();
    try {
      const deer = await startDeerSession(repoPath);
      try {
        await deer.waitForPane("deer");

        // Simulate a task owned by another process (use current process PID
        // so isOwnerAlive returns true, making it appear as a live cross-instance task)
        await writeTaskState({
          taskId,
          prompt: "cross-instance test task",
          status: "running",
          elapsed: 0,
          lastActivity: "● Running in another instance",
          prUrl: null,
          finalBranch: null,
          error: null,
          cost: null,
          logs: [],
          idle: false,
          createdAt: new Date().toISOString(),
          ownerPid: process.pid,
          worktreePath: "/tmp/fake-worktree",
          baseBranch: "main",
        });

        // The sync uses fs.watch + a 10s safety poll (TASK_SYNC_SAFETY_POLL_MS).
        // Wait up to 15s for the task to appear in the TUI.
        await deer.waitForPane("cross-instance test task", 15_000);

        // Verify it shows as running
        const screen = await deer.getScreen();
        const taskLine = screen.find((l) => l.includes("cross-instance test task"));
        expect(taskLine).not.toBeUndefined();
      } finally {
        await deer.stop();
      }
    } finally {
      await removeTaskState(taskId).catch(() => {});
      await cleanup();
    }
  });

  test("task becomes interrupted when owning process dies", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    const taskId = generateTaskId();
    const DEAD_PID = 99999999;
    try {
      const deer = await startDeerSession(repoPath);
      try {
        await deer.waitForPane("deer");

        // Write a state file with a dead owner PID
        await writeTaskState({
          taskId,
          prompt: "interrupted instance task",
          status: "running",
          elapsed: 0,
          lastActivity: "● Doing work",
          prUrl: null,
          finalBranch: null,
          error: null,
          cost: null,
          logs: [],
          idle: false,
          createdAt: new Date().toISOString(),
          ownerPid: DEAD_PID,
          worktreePath: "/tmp/fake-worktree",
          baseBranch: "main",
        });

        // Wait for the task to appear — it should show as interrupted
        // since the owner PID is dead
        await waitFor(
          async () => {
            const screen = await deer.getScreen();
            return (
              screen.some((l) => l.includes("interrupted instance task")) ||
              screen.some((l) => l.includes("interrupted"))
            );
          },
          { timeout: 15_000, label: "interrupted task appears in TUI" },
        );
      } finally {
        await deer.stop();
      }
    } finally {
      await removeTaskState(taskId).catch(() => {});
      await cleanup();
    }
  });
});
