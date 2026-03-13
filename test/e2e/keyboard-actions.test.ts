/**
 * Keyboard action E2E tests.
 *
 * Verify that keyboard actions (kill, delete, retry) actually work end-to-end.
 * These tests catch silent action failures that unit tests miss.
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";

import {
  startDeerSession,
  createTestRepo,
  withFakeClaude,
  withSlowFakeClaude,
  waitFor,
  waitForNewTaskDir,
} from "./helpers";
import { isTmuxSessionDead } from "../../src/sandbox/index";
import { loadHistory } from "../../src/task";

setDefaultTimeout(120_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("keyboard actions", () => {
  test("'x' kills a running agent after confirmation", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withSlowFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForPane("deer");

          const before = Date.now();
          deer.sendKeys("kill this task\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for the agent tmux session to appear
          await waitFor(
            async () => !(await isTmuxSessionDead(`deer-${taskId}`)),
            { timeout: 15_000, label: "agent tmux session appears" },
          );

          // Running task is selected by default — send kill action
          deer.sendKeys("x");

          // Confirmation prompt should appear
          await deer.waitForPane("Cancel", 10_000);

          // Confirm the kill
          deer.sendKeys("\r");

          // Agent tmux session should die
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 15_000, label: "agent session dies after kill" },
          );

          // TUI should show cancelled state
          await deer.waitForPane("cancelled", 15_000);

          // History should record status: "cancelled"
          await waitFor(
            async () => {
              const history = await loadHistory(repoPath);
              const entry = history.find((t) => t.taskId === taskId);
              return entry?.status === "cancelled";
            },
            { timeout: 10_000, label: "history shows cancelled" },
          );
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("Backspace removes a completed task from the TUI and history", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForPane("deer");

          const before = Date.now();
          deer.sendKeys("add logging\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for fake claude to finish
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 30_000, label: "agent session dies" },
          );

          // Wait for task to appear in history (deer has processed completion)
          await waitFor(
            async () => {
              const history = await loadHistory(repoPath);
              return history.some((t) => t.taskId === taskId);
            },
            { timeout: 15_000, label: "task in history" },
          );

          // Select the completed task and press Backspace to delete
          deer.sendKeys("\x7f");

          // History should no longer contain this task
          await waitFor(
            async () => {
              const history = await loadHistory(repoPath);
              return !history.some((t) => t.taskId === taskId);
            },
            { timeout: 15_000, label: "task removed from history" },
          );

          // TUI should no longer show the taskId
          const screen = await deer.getScreen();
          expect(screen.some((l) => l.includes(taskId))).toBe(false);
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("'r' retries a completed task by reopening the same tmux session", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForPane("deer");

          const before = Date.now();
          deer.sendKeys("refactor the parser\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for fake claude to finish
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 30_000, label: "agent session dies" },
          );

          // Wait for deer to register completion
          await waitFor(
            async () => {
              const history = await loadHistory(repoPath);
              return history.some((t) => t.taskId === taskId);
            },
            { timeout: 15_000, label: "task in history" },
          );

          // Retry the task
          deer.sendKeys("r");

          // A new tmux session for the same taskId should appear
          await waitFor(
            async () => !(await isTmuxSessionDead(`deer-${taskId}`)),
            { timeout: 15_000, label: "retry tmux session appears" },
          );
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });
});
