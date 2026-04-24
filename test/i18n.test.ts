import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// detectLang reads process.argv and process.env at call time, so we can
// manipulate them per-test and restore afterwards.

describe("detectLang", () => {
  let origArgv: string[];
  let origLang: string | undefined;
  let origClaudeLocale: string | undefined;

  beforeEach(() => {
    origArgv = process.argv.slice();
    origLang = process.env.LANG;
    origClaudeLocale = process.env.CLAUDE_CODE_LOCALE;
    delete process.env.LANG;
    delete process.env.CLAUDE_CODE_LOCALE;
  });

  afterEach(() => {
    process.argv = origArgv;
    if (origLang === undefined) delete process.env.LANG;
    else process.env.LANG = origLang;
    if (origClaudeLocale === undefined) delete process.env.CLAUDE_CODE_LOCALE;
    else process.env.CLAUDE_CODE_LOCALE = origClaudeLocale;
  });

  function withArgs(args: string[]) {
    process.argv = ["bun", "deer", ...args];
  }

  test("--lang=en overrides LANG=ja_JP.UTF-8", async () => {
    const { detectLang } = await import("../packages/shared/src/i18n");
    withArgs(["--lang=en"]);
    process.env.LANG = "ja_JP.UTF-8";
    expect(detectLang()).toBe("en");
  });

  test("--lang=en overrides CLAUDE_CODE_LOCALE=ja", async () => {
    const { detectLang } = await import("../packages/shared/src/i18n");
    withArgs(["--lang=en"]);
    process.env.CLAUDE_CODE_LOCALE = "ja_JP";
    expect(detectLang()).toBe("en");
  });

  test("LANG=ja_JP.UTF-8 without --lang flag detects Japanese", async () => {
    const { detectLang } = await import("../packages/shared/src/i18n");
    withArgs([]);
    process.env.LANG = "ja_JP.UTF-8";
    expect(detectLang()).toBe("ja");
  });

  test("--lang=ja detects Japanese", async () => {
    const { detectLang } = await import("../packages/shared/src/i18n");
    withArgs(["--lang=ja"]);
    expect(detectLang()).toBe("ja");
  });

  test("--lang=jp detects Japanese", async () => {
    const { detectLang } = await import("../packages/shared/src/i18n");
    withArgs(["--lang=jp"]);
    expect(detectLang()).toBe("ja");
  });

  test("defaults to en with no flags or locale env vars", async () => {
    const { detectLang } = await import("../packages/shared/src/i18n");
    withArgs([]);
    expect(detectLang()).toBe("en");
  });
});
