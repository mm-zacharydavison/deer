import { test, expect, describe } from "bun:test";
import { permissionModeArgs, DEFAULT_CONFIG } from "deerbox";
import type { DeerConfig } from "deerbox";

function configWith(mode: DeerConfig["defaults"]["permissionMode"]): DeerConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.defaults.permissionMode = mode;
  return cfg;
}

describe("permissionModeArgs", () => {
  test("auto mode yields --permission-mode auto", () => {
    expect(permissionModeArgs(configWith("auto"))).toEqual(["--permission-mode", "auto"]);
  });

  test("bypassPermissions yields --dangerously-skip-permissions", () => {
    expect(permissionModeArgs(configWith("bypassPermissions"))).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  test("undefined permissionMode defaults to auto", () => {
    expect(permissionModeArgs(configWith(undefined))).toEqual(["--permission-mode", "auto"]);
  });
});
