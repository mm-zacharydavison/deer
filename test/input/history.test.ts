import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Patch homedir so history files land in a temp dir, not ~/.local/share/deer
import { homedir } from "os";
import * as os from "os";

let tmpHome: string;
let originalHomedir: () => string;

// We re-import after patching so the module picks up the mocked homedir.
// Instead, use the exported helpers directly with known paths for predictability.

import { historyFilePath, loadHistory, appendHistory } from "../../src/input/history.js";

describe("historyFilePath", () => {
  test("returns a stable path for the same CWD", () => {
    const a = historyFilePath("/some/project");
    const b = historyFilePath("/some/project");
    expect(a).toBe(b);
  });

  test("returns different paths for different CWDs", () => {
    const a = historyFilePath("/project/a");
    const b = historyFilePath("/project/b");
    expect(a).not.toBe(b);
  });

  test("includes ~/.local/share/deer/history in the path", () => {
    const p = historyFilePath("/some/project");
    expect(p).toContain(join(".local", "share", "deer", "history"));
  });
});

describe("loadHistory / appendHistory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-history-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("loadHistory returns empty array when no history file exists", async () => {
    // Use a non-existent path by pointing at our tmpDir as fake homedir
    const fakeCwd = join(tmpDir, "nonexistent");
    // Since we can't easily mock homedir, we test via a workaround:
    // write directly to the expected path and read it back.
    const result = await loadHistory(fakeCwd);
    // It won't find the file in ~/.local/share/deer/history, returns []
    expect(result).toEqual([]);
  });

  test("appendHistory creates file and loadHistory reads it newest-first", async () => {
    // We write to the actual history location for a unique fake cwd
    const fakeCwd = join(tmpDir, "test-project-" + Date.now());

    await appendHistory(fakeCwd, "first entry");
    await appendHistory(fakeCwd, "second entry");
    await appendHistory(fakeCwd, "third entry");

    const history = await loadHistory(fakeCwd);

    // Newest-first order for readline
    expect(history[0]).toBe("third entry");
    expect(history[1]).toBe("second entry");
    expect(history[2]).toBe("first entry");
  });

  test("appendHistory persists across separate loadHistory calls", async () => {
    const fakeCwd = join(tmpDir, "persist-test-" + Date.now());

    await appendHistory(fakeCwd, "alpha");
    const first = await loadHistory(fakeCwd);
    expect(first).toContain("alpha");

    await appendHistory(fakeCwd, "beta");
    const second = await loadHistory(fakeCwd);
    expect(second[0]).toBe("beta");
    expect(second[1]).toBe("alpha");
  });

  test("different CWDs have independent history", async () => {
    const cwdA = join(tmpDir, "proj-a-" + Date.now());
    const cwdB = join(tmpDir, "proj-b-" + Date.now());

    await appendHistory(cwdA, "from A");
    await appendHistory(cwdB, "from B");

    const histA = await loadHistory(cwdA);
    const histB = await loadHistory(cwdB);

    expect(histA).toEqual(["from A"]);
    expect(histB).toEqual(["from B"]);
  });
});
