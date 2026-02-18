import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { detectInputType, resolveInstruction } from "../../src/input/detect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("detectInputType", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-input-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("HTTPS URL → url with domain extracted", async () => {
    const result = await detectInputType("https://github.com/org/repo/issues/42");
    expect(result).toEqual({
      kind: "url",
      url: "https://github.com/org/repo/issues/42",
      domain: "github.com",
    });
  });

  test("HTTP URL → url with domain extracted", async () => {
    const result = await detectInputType("http://example.com/page");
    expect(result).toEqual({
      kind: "url",
      url: "http://example.com/page",
      domain: "example.com",
    });
  });

  test("Notion URL → url with notion.so domain", async () => {
    const result = await detectInputType("https://notion.so/page/abc");
    expect(result).toEqual({
      kind: "url",
      url: "https://notion.so/page/abc",
      domain: "notion.so",
    });
  });

  test("existing .md file → file", async () => {
    const filePath = join(tmpDir, "task.md");
    await Bun.write(filePath, "# Fix the bug");

    const result = await detectInputType(filePath);
    expect(result).toEqual({ kind: "file", path: filePath });
  });

  test("existing .txt file → file", async () => {
    const filePath = join(tmpDir, "task.txt");
    await Bun.write(filePath, "Fix the bug");

    const result = await detectInputType(filePath);
    expect(result).toEqual({ kind: "file", path: filePath });
  });

  test("non-existent .md file → text (not file)", async () => {
    const result = await detectInputType("/tmp/does-not-exist-deer-test.md");
    expect(result.kind).toBe("text");
  });

  test("plain text → text", async () => {
    const result = await detectInputType("Fix the login bug");
    expect(result).toEqual({ kind: "text", text: "Fix the login bug" });
  });

  test("multi-word plain text → text", async () => {
    const result = await detectInputType("Add a health check endpoint to the internal API");
    expect(result).toEqual({
      kind: "text",
      text: "Add a health check endpoint to the internal API",
    });
  });
});

describe("resolveInstruction", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deer-resolve-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("plain text → instruction is the text, source is 'inline'", async () => {
    const result = await resolveInstruction("Fix the login bug");
    expect(result).toEqual({
      instruction: "Fix the login bug",
      source: "inline",
    });
  });

  test("file path → reads file content, source is the path", async () => {
    const filePath = join(tmpDir, "task.md");
    await Bun.write(filePath, "# Fix the bug\n\nDetails here.");

    const result = await resolveInstruction(filePath);
    expect(result.instruction).toBe("# Fix the bug\n\nDetails here.");
    expect(result.source).toBe(filePath);
  });
});
