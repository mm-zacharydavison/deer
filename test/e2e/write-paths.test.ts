/**
 * Write paths E2E tests.
 *
 * Verify that write_paths_extra in deer.toml propagates through the full
 * pipeline (config → session → srt-settings.json) into the sandbox's
 * allowWrite list.
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { join, basename } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  startDeerSession,
  createTestRepo,
  withFakeClaude,
  waitFor,
  waitForNewTaskDir,
} from "./helpers";
import { dataDir } from "../../src/task";

setDefaultTimeout(120_000);

const HOME = process.env.HOME ?? "/root";
const e2e = process.env.DEER_E2E ? describe : describe.skip;

e2e("write_paths", () => {
  test("absolute write_paths_extra from deer.toml appear in srt-settings allowWrite", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    const extraWriteDir = await mkdtemp(join(tmpdir(), "deer-e2e-wp-"));
    try {
      await Bun.write(
        join(repoPath, "deer.toml"),
        `[sandbox]\nwrite_paths_extra = ["${extraWriteDir}"]\n`,
      );

      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady(30_000);

          const before = Date.now();
          deer.sendKeys("test write paths\r");

          const taskId = await waitForNewTaskDir(before);
          const slug = basename(repoPath);
          const settingsPath = join(
            dataDir(),
            "tasks",
            slug,
            taskId,
            "srt-settings.json",
          );

          await waitFor(
            async () => Bun.file(settingsPath).exists(),
            { timeout: 15_000, label: "srt-settings.json exists" },
          );

          const settings = JSON.parse(await Bun.file(settingsPath).text());
          const allowWrite: string[] = settings.filesystem.allowWrite;

          expect(allowWrite).toContain(extraWriteDir);
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
      await rm(extraWriteDir, { recursive: true, force: true });
    }
  });

  test("tilde write_paths_extra resolve to $HOME and are not denied for reading", async () => {
    const { repoPath, cleanup } = await createTestRepo();
    const dirName = `.deer-e2e-wp-${process.pid}`;
    const resolvedPath = join(HOME, dirName);
    try {
      await mkdir(resolvedPath, { recursive: true });
      await Bun.write(
        join(repoPath, "deer.toml"),
        `[sandbox]\nwrite_paths_extra = ["~/${dirName}"]\n`,
      );

      await withFakeClaude(async (env) => {
        const deer = await startDeerSession(repoPath, env);
        try {
          await deer.waitForReady(30_000);

          const before = Date.now();
          deer.sendKeys("test tilde write paths\r");

          const taskId = await waitForNewTaskDir(before);
          const slug = basename(repoPath);
          const settingsPath = join(
            dataDir(),
            "tasks",
            slug,
            taskId,
            "srt-settings.json",
          );

          await waitFor(
            async () => Bun.file(settingsPath).exists(),
            { timeout: 15_000, label: "srt-settings.json exists" },
          );

          const settings = JSON.parse(await Bun.file(settingsPath).text());
          const allowWrite: string[] = settings.filesystem.allowWrite;
          const denyRead: string[] = settings.filesystem.denyRead;

          // Tilde should be resolved to the full $HOME path
          expect(allowWrite).toContain(resolvedPath);
          expect(allowWrite).not.toContain(`~/${dirName}`);

          // Home entry must not be blocked for reading
          expect(denyRead).not.toContain(resolvedPath);
        } finally {
          await deer.stop();
        }
      });
    } finally {
      await cleanup();
      await rm(resolvedPath, { recursive: true, force: true });
    }
  });
});
