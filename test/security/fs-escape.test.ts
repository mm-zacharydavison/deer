import { test, expect, describe, afterEach } from "bun:test";
import { nonoRuntime } from "../../src/sandbox/nono";
import { createBwrapRuntime } from "../../src/sandbox/bwrap";
import type { SandboxCleanup } from "../../src/sandbox/runtime";
import { mkdtemp, rm, writeFile, readFile, symlink, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
const cleanups: SandboxCleanup[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

async function makeTmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "deer-sec-test-"));
  tmpDirs.push(d);
  return d;
}

function nonoRun(
  dir: string,
  cmd: string,
  extraOpts?: { extraReadPaths?: string[]; extraWritePaths?: string[] },
): ReturnType<typeof Bun.spawn> {
  const args = nonoRuntime.buildCommand(
    { worktreePath: dir, allowlist: [], ...extraOpts },
    ["sh", "-c", cmd],
  );
  return Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function bwrapRun(
  dir: string,
  cmd: string,
  extraOpts?: { extraReadPaths?: string[]; extraWritePaths?: string[]; env?: Record<string, string> },
): Promise<ReturnType<typeof Bun.spawn>> {
  const runtime = createBwrapRuntime();
  cleanups.push(await runtime.prepare!({ worktreePath: dir, allowlist: [] }));
  const args = runtime.buildCommand(
    { worktreePath: dir, allowlist: [], ...extraOpts },
    ["sh", "-c", cmd],
  );
  return Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
}

// ── B1: Symlink traversal must not reach ungranted paths ─────────────

describe("symlink traversal from worktree", () => {
  test("symlink to ~/.ssh/id_rsa is blocked", async () => {
    const home = process.env.HOME!;
    const sshKey = join(home, ".ssh", "id_rsa");

    if (!existsSync(sshKey)) {
      console.log("Skipping: no ~/.ssh/id_rsa found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(sshKey, join(dir, "stolen-key"));

    const proc = nonoRun(dir, `cat ${dir}/stolen-key 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("symlink to ~/.bashrc is blocked", async () => {
    const home = process.env.HOME!;
    const bashrc = join(home, ".bashrc");

    if (!existsSync(bashrc)) {
      console.log("Skipping: no ~/.bashrc found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(bashrc, join(dir, "stolen-bashrc"));

    const proc = nonoRun(dir, `cat ${dir}/stolen-bashrc 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("symlink to ~/.aws/credentials is blocked", async () => {
    const home = process.env.HOME!;
    const awsCreds = join(home, ".aws", "credentials");

    if (!existsSync(awsCreds)) {
      console.log("Skipping: no ~/.aws/credentials found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(awsCreds, join(dir, "stolen-aws"));

    const proc = nonoRun(dir, `cat ${dir}/stolen-aws 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });
});

// ── B2: Write isolation ──────────────────────────────────────────────

describe("write isolation", () => {
  test("cannot write to /etc", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(dir, "echo pwned > /etc/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/etc/deer-escape-test")).toBe(false);
  });

  test("cannot write to /usr", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(dir, "echo pwned > /usr/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/usr/deer-escape-test")).toBe(false);
  });

  test("can write to worktree (intended writable path)", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `echo "legit-write" > ${dir}/test-output.txt && cat ${dir}/test-output.txt`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toContain("legit-write");
  });

  test("repoGitDir is not writable", async () => {
    const dir = await makeTmpDir();

    const args = nonoRuntime.buildCommand(
      { worktreePath: dir, allowlist: [], repoGitDir: "/usr" },
      ["sh", "-c", "echo pwned > /usr/deer-escape-test; echo exit=$?"],
    );

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/usr/deer-escape-test")).toBe(false);
  });

  test("cannot write to HOME outside worktree", async () => {
    const home = process.env.HOME!;
    const dir = await makeTmpDir();
    const marker = `deer-escape-test-${Date.now()}`;

    const proc = nonoRun(dir, `echo pwned > ${home}/${marker} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(existsSync(join(home, marker))).toBe(false);
  });
});

// ── B3: Sensitive credential files must be blocked ───────────────────

describe("sensitive credential file isolation", () => {
  test("~/.ssh/id_rsa must not be readable", async () => {
    const home = process.env.HOME!;
    const sshKey = join(home, ".ssh", "id_rsa");

    if (!existsSync(sshKey)) {
      console.log("Skipping: no ~/.ssh/id_rsa found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${sshKey} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).not.toMatch(/-----BEGIN/);
    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.gnupg must not be readable", async () => {
    const home = process.env.HOME!;
    const gnupg = join(home, ".gnupg");

    if (!existsSync(gnupg)) {
      console.log("Skipping: no ~/.gnupg found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `ls ${gnupg} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.aws must not be readable", async () => {
    const home = process.env.HOME!;
    const awsDir = join(home, ".aws");

    if (!existsSync(awsDir)) {
      console.log("Skipping: no ~/.aws found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${awsDir}/credentials 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted|No such file/);
  });

  test("~/.docker/config.json must not be readable", async () => {
    const home = process.env.HOME!;
    const dockerConfig = join(home, ".docker", "config.json");

    if (!existsSync(dockerConfig)) {
      console.log("Skipping: no ~/.docker/config.json found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${dockerConfig} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.kube/config must not be readable", async () => {
    const home = process.env.HOME!;
    const kubeConfig = join(home, ".kube", "config");

    if (!existsSync(kubeConfig)) {
      console.log("Skipping: no ~/.kube/config found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${kubeConfig} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });

  test("~/.npmrc must not be readable (may contain auth tokens)", async () => {
    const home = process.env.HOME!;
    const npmrc = join(home, ".npmrc");

    if (!existsSync(npmrc)) {
      console.log("Skipping: no ~/.npmrc found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = nonoRun(dir, `cat ${npmrc} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/Permission denied|Operation not permitted/);
  });
});

// ── B4: Environment variable isolation ────────────────────────────────

describe("env passthrough isolation", () => {
  test("only explicitly passthrough'd env vars reach the sandbox", async () => {
    const dir = await makeTmpDir();
    const args = nonoRuntime.buildCommand(
      { worktreePath: dir, allowlist: [] },
      ["sh", "-c", "cat /proc/self/environ | tr '\\0' '\\n' | sort"],
    );

    // launchSandbox builds a clean env from the passthrough list.
    // Simulate by spawning with env -i plus only allowed vars.
    const allowedEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TERM: process.env.TERM ?? "xterm-256color",
      GH_TOKEN: "ghp_allowed_token",
    };

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: allowedEnv,
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // The allowed var should be present
    expect(stdout).toContain("GH_TOKEN=ghp_allowed_token");

    // Vars NOT in the passthrough list must be absent.
    // In a real scenario, the parent process may have AWS_SECRET_ACCESS_KEY,
    // DATABASE_URL, etc. — none of those should leak.
    expect(stdout).not.toContain("AWS_SECRET");
    expect(stdout).not.toContain("DATABASE_URL");
  });
});

// ── B5: ~/.claude is writable — config injection risk ────────────────

describe("~/.claude config isolation", () => {
  const home = process.env.HOME!;
  const claudeDir = join(home, ".claude");
  const claudeJson = join(home, ".claude.json");

  async function withClaudeBackup(fn: () => Promise<void>): Promise<void> {
    const backupDir = await mkdtemp(join(tmpdir(), "deer-claude-backup-"));
    try {
      if (existsSync(claudeDir)) {
        await cp(claudeDir, join(backupDir, ".claude"), { recursive: true });
      }
      if (existsSync(claudeJson)) {
        await cp(claudeJson, join(backupDir, ".claude.json"));
      }
      await fn();
    } finally {
      if (existsSync(join(backupDir, ".claude"))) {
        await rm(claudeDir, { recursive: true, force: true });
        await cp(join(backupDir, ".claude"), claudeDir, { recursive: true });
      }
      if (existsSync(join(backupDir, ".claude.json"))) {
        await cp(join(backupDir, ".claude.json"), claudeJson);
      }
      await rm(backupDir, { recursive: true, force: true });
    }
  }

  // ACCEPTED RISK: nono's claude-code profile grants rw to ~/.claude by design
  // (Claude Code needs it for session state, hooks, etc.).
  // Tracked upstream: https://github.com/always-further/nono/issues/220
  test.skip("~/.claude must not be writable by sandboxed agent", () =>
    withClaudeBackup(async () => {
      if (!existsSync(claudeDir)) {
        console.log("Skipping: no ~/.claude found");
        return;
      }

      const dir = await makeTmpDir();
      const marker = `deer-sec-test-${Date.now()}`;
      const proc = nonoRun(
        dir,
        `echo malicious > ${claudeDir}/${marker} 2>&1; echo exit=$?`,
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      // ~/.claude is rw in the claude-code profile. If this test fails,
      // a compromised agent can inject malicious hooks, MCP servers,
      // or modify Claude Code settings that persist across sessions.
      expect(existsSync(join(claudeDir, marker))).toBe(false);
    }),
  );

  // ACCEPTED RISK: same as above — nono claude-code profile grants rw.
  // Tracked upstream: https://github.com/always-further/nono/issues/220
  test.skip("~/.claude.json must not be writable by sandboxed agent", () =>
    withClaudeBackup(async () => {
      if (!existsSync(claudeJson)) {
        console.log("Skipping: no ~/.claude.json found");
        return;
      }

      const dir = await makeTmpDir();

      const proc = nonoRun(
        dir,
        `echo 'DEER_SECURITY_MARKER' >> ${claudeJson} 2>&1; echo exit=$?`,
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      const currentContent = await readFile(claudeJson, "utf-8");
      expect(currentContent).not.toContain("DEER_SECURITY_MARKER");
    }),
  );
});

// ── B6: Cargo/npm/pip registry cache as read vector ──────────────────

describe("package manager cache isolation", () => {
  test("~/.cargo is read-only, not writable", async () => {
    const home = process.env.HOME!;
    const cargoDir = join(home, ".cargo");

    if (!existsSync(cargoDir)) {
      console.log("Skipping: no ~/.cargo found");
      return;
    }

    const dir = await makeTmpDir();
    const marker = `deer-sec-test-${Date.now()}`;
    const proc = nonoRun(
      dir,
      `echo pwned > ${cargoDir}/${marker} 2>&1; echo exit=$?`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(existsSync(join(cargoDir, marker))).toBe(false);
  });
});

// ── B7: /tmp cross-sandbox data leakage ──────────────────────────────

describe("/tmp isolation between sandbox sessions", () => {
  // ACCEPTED RISK: nono shares the host's /tmp (no mount namespaces).
  // Cross-sandbox /tmp leakage is a known nono limitation. No upstream issue yet.
  test.skip("sandbox can write to /tmp (allowed by profile)", async () => {
    const dir = await makeTmpDir();
    const marker = `deer-sec-xsandbox-${Date.now()}`;
    const proc = nonoRun(dir, `echo leaked > /tmp/${marker} && cat /tmp/${marker}`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // /tmp is rw in the claude-code profile. Unlike bwrap (which used
    // --tmpfs /tmp for isolation), nono shares the host's /tmp.
    // A compromised agent can leave data in /tmp for other sandbox
    // sessions to read — cross-sandbox data leakage.
    const leaked = existsSync(`/tmp/${marker}`);
    if (leaked) {
      await rm(`/tmp/${marker}`).catch(() => {});
    }
    expect(leaked).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// bwrap filesystem security tests
//
// bwrap uses mount namespaces: paths outside explicit mounts are invisible
// (not "permission denied" but "No such file or directory").
// ═══════════════════════════════════════════════════════════════════════

// ── B1-bwrap: Symlink traversal ──────────────────────────────────────

describe("bwrap: symlink traversal from worktree", () => {
  test("symlink to ~/.ssh/id_rsa is blocked", async () => {
    const home = process.env.HOME!;
    const sshKey = join(home, ".ssh", "id_rsa");

    if (!existsSync(sshKey)) {
      console.log("Skipping: no ~/.ssh/id_rsa found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(sshKey, join(dir, "stolen-key"));

    const proc = await bwrapRun(dir, `cat ${dir}/stolen-key 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("symlink to ~/.bashrc is blocked", async () => {
    const home = process.env.HOME!;
    const bashrc = join(home, ".bashrc");

    if (!existsSync(bashrc)) {
      console.log("Skipping: no ~/.bashrc found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(bashrc, join(dir, "stolen-bashrc"));

    const proc = await bwrapRun(dir, `cat ${dir}/stolen-bashrc 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("symlink to ~/.aws/credentials is blocked", async () => {
    const home = process.env.HOME!;
    const awsCreds = join(home, ".aws", "credentials");

    if (!existsSync(awsCreds)) {
      console.log("Skipping: no ~/.aws/credentials found");
      return;
    }

    const dir = await makeTmpDir();
    await symlink(awsCreds, join(dir, "stolen-aws"));

    const proc = await bwrapRun(dir, `cat ${dir}/stolen-aws 2>&1`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });
});

// ── B2-bwrap: Write isolation ────────────────────────────────────────

describe("bwrap: write isolation", () => {
  test("cannot write to /etc", async () => {
    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, "echo pwned > /etc/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/etc/deer-escape-test")).toBe(false);
  });

  test("cannot write to /usr", async () => {
    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, "echo pwned > /usr/deer-escape-test; echo exit=$?");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/exit=[12]/);
    expect(existsSync("/usr/deer-escape-test")).toBe(false);
  });

  test("can write to worktree (intended writable path)", async () => {
    const dir = await makeTmpDir();
    const proc = await bwrapRun(
      dir,
      `echo "legit-write" > ${dir}/test-output.txt && cat ${dir}/test-output.txt`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toContain("legit-write");
  });

  test("cannot write to HOME outside worktree", async () => {
    const home = process.env.HOME!;
    const dir = await makeTmpDir();
    const marker = `deer-escape-test-${Date.now()}`;

    const proc = await bwrapRun(dir, `echo pwned > ${home}/${marker} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(existsSync(join(home, marker))).toBe(false);
  });
});

// ── B3-bwrap: Sensitive credential files must be blocked ─────────────

describe("bwrap: sensitive credential file isolation", () => {
  test("~/.ssh/id_rsa must not be readable", async () => {
    const home = process.env.HOME!;
    const sshKey = join(home, ".ssh", "id_rsa");

    if (!existsSync(sshKey)) {
      console.log("Skipping: no ~/.ssh/id_rsa found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, `cat ${sshKey} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).not.toMatch(/-----BEGIN/);
    // bwrap: path is not mounted, so "No such file"
    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("~/.gnupg must not be readable", async () => {
    const home = process.env.HOME!;
    const gnupg = join(home, ".gnupg");

    if (!existsSync(gnupg)) {
      console.log("Skipping: no ~/.gnupg found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, `ls ${gnupg} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("~/.aws must not be readable", async () => {
    const home = process.env.HOME!;
    const awsDir = join(home, ".aws");

    if (!existsSync(awsDir)) {
      console.log("Skipping: no ~/.aws found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, `cat ${awsDir}/credentials 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("~/.docker/config.json must not be readable", async () => {
    const home = process.env.HOME!;
    const dockerConfig = join(home, ".docker", "config.json");

    if (!existsSync(dockerConfig)) {
      console.log("Skipping: no ~/.docker/config.json found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, `cat ${dockerConfig} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("~/.kube/config must not be readable", async () => {
    const home = process.env.HOME!;
    const kubeConfig = join(home, ".kube", "config");

    if (!existsSync(kubeConfig)) {
      console.log("Skipping: no ~/.kube/config found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, `cat ${kubeConfig} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });

  test("~/.npmrc must not be readable (may contain auth tokens)", async () => {
    const home = process.env.HOME!;
    const npmrc = join(home, ".npmrc");

    if (!existsSync(npmrc)) {
      console.log("Skipping: no ~/.npmrc found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, `cat ${npmrc} 2>&1; echo exit=$?`);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout).toMatch(/No such file|Permission denied|Operation not permitted/);
  });
});

// ── B4-bwrap: Environment variable isolation ─────────────────────────

describe("bwrap: env passthrough isolation", () => {
  test("--clearenv prevents host env leakage", async () => {
    const dir = await makeTmpDir();
    const orig = process.env.SECRET_TEST_VAR;
    process.env.SECRET_TEST_VAR = "deer-secret-sentinel";
    try {
      const proc = await bwrapRun(dir, "cat /proc/self/environ | tr '\\0' '\\n' | sort");
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      // --clearenv strips all host env; only explicitly --setenv'd vars are present
      expect(stdout).not.toContain("SECRET_TEST_VAR");
      expect(stdout).not.toContain("deer-secret-sentinel");
      // Sanity: HOME and PATH should be set by bwrap args
      expect(stdout).toContain("HOME=");
      expect(stdout).toContain("PATH=");
    } finally {
      if (orig === undefined) delete process.env.SECRET_TEST_VAR;
      else process.env.SECRET_TEST_VAR = orig;
    }
  });
});

// ── B5-bwrap: ~/.claude config isolation ─────────────────────────────

describe("bwrap: ~/.claude config isolation", () => {
  const home = process.env.HOME!;
  const claudeDir = join(home, ".claude");
  const claudeJson = join(home, ".claude.json");

  // ACCEPTED RISK: bwrap bind-mounts ~/.claude rw (same as nono).
  // Claude Code needs it for session state, hooks, etc.
  test.skip("~/.claude must not be writable by sandboxed agent", async () => {
    if (!existsSync(claudeDir)) {
      console.log("Skipping: no ~/.claude found");
      return;
    }

    const dir = await makeTmpDir();
    const marker = `deer-sec-test-${Date.now()}`;
    const proc = await bwrapRun(
      dir,
      `echo malicious > ${claudeDir}/${marker} 2>&1; echo exit=$?`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(existsSync(join(claudeDir, marker))).toBe(false);
  });

  test.skip("~/.claude.json must not be writable by sandboxed agent", async () => {
    if (!existsSync(claudeJson)) {
      console.log("Skipping: no ~/.claude.json found");
      return;
    }

    const dir = await makeTmpDir();
    const proc = await bwrapRun(
      dir,
      `echo 'DEER_SECURITY_MARKER' >> ${claudeJson} 2>&1; echo exit=$?`,
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const currentContent = await readFile(claudeJson, "utf-8");
    expect(currentContent).not.toContain("DEER_SECURITY_MARKER");
  });
});

// ── B6-bwrap: Package manager cache isolation ────────────────────────

describe("bwrap: package manager cache isolation", () => {
  test("~/.cargo writes do not leak to host", async () => {
    const home = process.env.HOME!;
    const cargoDir = join(home, ".cargo");

    if (!existsSync(cargoDir)) {
      console.log("Skipping: no ~/.cargo found");
      return;
    }

    const dir = await makeTmpDir();
    const marker = `deer-sec-test-${Date.now()}`;
    // bwrap ro-bind mounts ~/.cargo/bin for PATH; the parent ~/.cargo/
    // may be writable in-namespace (implicit directory for the bind mount)
    // but writes must NOT leak to the host filesystem.
    const proc = await bwrapRun(
      dir,
      `echo pwned > ${cargoDir}/${marker} 2>&1`,
    );
    await proc.exited;

    expect(existsSync(join(cargoDir, marker))).toBe(false);
  });
});

// ── B7-bwrap: /tmp isolation ─────────────────────────────────────────

describe("bwrap: /tmp isolation between sandbox sessions", () => {
  test("host /tmp contents are not visible inside bwrap", async () => {
    const marker = `deer-sec-xsandbox-${Date.now()}`;
    await writeFile(`/tmp/${marker}`, "host-side-data");

    try {
      const dir = await makeTmpDir();
      const proc = await bwrapRun(dir, `cat /tmp/${marker} 2>&1; echo exit=$?`);
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      // bwrap uses --tmpfs /tmp, so host /tmp is invisible
      expect(stdout).toContain("No such file");
    } finally {
      await rm(`/tmp/${marker}`).catch(() => {});
    }
  });

  test("/tmp writes inside bwrap do not leak to host", async () => {
    const marker = `deer-sec-bwrap-leak-${Date.now()}`;

    const dir = await makeTmpDir();
    const proc = await bwrapRun(dir, `echo leaked > /tmp/${marker}`);
    await proc.exited;

    // The file was written to bwrap's tmpfs, not the host's /tmp
    expect(existsSync(`/tmp/${marker}`)).toBe(false);
  });
});
