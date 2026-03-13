/**
 * Agent lifecycle E2E tests.
 *
 * Verify the full path from prompt submission through agent completion.
 * This is the most important E2E test — it catches the most regressions.
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";

import { startDeerSession, createTestRepo, withFakeClaude, waitFor, waitForNewTaskDir } from "./helpers";
import { isTmuxSessionDead } from "../../src/sandbox/index";
import { readTaskState } from "../../src/task-state";
import { loadHistory } from "../../src/task";

setDefaultTimeout(120_000);

const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("agent lifecycle", () => {
  test("submitting a prompt creates a worktree and tmux session", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForPane("deer");

          const before = Date.now();
          deer.sendKeys("fix the bug\r");

          const taskId = await waitForNewTaskDir(before);

          // Verify the agent is running
          await waitFor(
            async () => {
              const state = await readTaskState(taskId);
              return state?.status === "running";
            },
            { timeout: 15_000, label: "state.json has status running" },
          );

          // Verify agent tmux session exists
          const sessionName = `deer-${taskId}`;
          await waitFor(
            async () => !(await isTmuxSessionDead(sessionName)),
            { timeout: 10_000, label: "agent tmux session is alive" },
          );

          // Wait for fake claude to finish
          await waitFor(
            async () => isTmuxSessionDead(sessionName),
            { timeout: 30_000, label: "agent tmux session dies (fake claude finished)" },
          );

          // Wait for deer to process completion and write to history
          await waitFor(
            async () => {
              const history = await loadHistory(repoPath);
              return history.some((t) => t.taskId === taskId);
            },
            { timeout: 15_000, label: "task appears in history" },
          );

          // Verify the task is no longer stuck as "running"
          const history = await loadHistory(repoPath);
          const entry = history.find((t) => t.taskId === taskId);
          expect(entry).not.toBeUndefined();
          expect(entry!.status).not.toBe("running");
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("state.json is removed after agent completes", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForPane("deer");

          const before = Date.now();
          deer.sendKeys("write a test\r");

          const taskId = await waitForNewTaskDir(before);

          // Wait for fake claude to finish and deer to process it
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 30_000, label: "agent session dies" },
          );

          // state.json should be removed once the task is fully processed
          await waitFor(
            async () => {
              const state = await readTaskState(taskId);
              return state === null;
            },
            { timeout: 15_000, label: "state.json removed" },
          );
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
    }
  });

  test("worktree directory exists while agent is running", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    try {
      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForPane("deer");

          const before = Date.now();
          deer.sendKeys("add some tests\r");

          const taskId = await waitForNewTaskDir(before);

          // Check the worktree exists while the agent is running
          await waitFor(
            async () => {
              const state = await readTaskState(taskId);
              if (!state?.worktreePath) return false;
              const gitDir = join(state.worktreePath, ".git");
              return Bun.file(gitDir).exists();
            },
            { timeout: 15_000, label: "worktree/.git exists" },
          );

          // Let the agent finish
          await waitFor(
            async () => isTmuxSessionDead(`deer-${taskId}`),
            { timeout: 30_000, label: "agent session dies" },
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
