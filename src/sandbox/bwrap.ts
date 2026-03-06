import { join, dirname } from "node:path";
import { existsSync, lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { startProxy, startApiProxy, type HostCredentials } from "./proxy";
import type { SandboxRuntime, SandboxRuntimeOptions, SandboxCleanup } from "./runtime";

/**
 * Paths that need to be available in the sandbox.
 *
 * On many distros /bin, /lib, /sbin are symlinks to /usr/*.
 * We detect this and use --symlink instead of --ro-bind to replicate
 * the host layout correctly.
 */
const SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/lib32",
  "/sbin",
  "/etc",
];

/**
 * Read Anthropic credentials from the host environment and config files.
 * Caller-supplied env vars take precedence over host env and config files.
 */
async function readHostCredentials(env?: Record<string, string>): Promise<HostCredentials> {
  // Caller-supplied env takes highest precedence
  if (env?.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY };
  if (env?.CLAUDE_CODE_OAUTH_TOKEN) return { oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN };

  // Host environment
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY };

  const home = process.env.HOME ?? "/root";

  // OAuth token from ~/.claude/.credentials.json
  const credentialsFile = join(home, ".claude", ".credentials.json");
  try {
    const raw = await readFile(credentialsFile, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
    const token = oauth?.accessToken as string | undefined;
    if (token) return { oauthToken: token };
  } catch {
    // File absent or unreadable
  }

  // API key from ~/.claude.json
  const claudeJsonPath = join(home, ".claude.json");
  try {
    const raw = await readFile(claudeJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const key = parsed.primaryApiKey as string | undefined;
    if (key) return { apiKey: key };
  } catch {
    // File absent or unreadable
  }

  return {};
}

/**
 * Write a sanitized copy of ~/.claude.json with credential fields removed.
 * Returns the path to the temp file.
 */
async function createSanitizedClaudeJson(sourcePath: string): Promise<string> {
  const tmpPath = join(tmpdir(), `deer-claude-sanitized-${Date.now()}.json`);
  try {
    const raw = await readFile(sourcePath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    delete config.primaryApiKey;
    delete config.oauthAccount;
    await writeFile(tmpPath, JSON.stringify(config));
  } catch {
    await writeFile(tmpPath, "{}");
  }
  return tmpPath;
}

/** Env vars that carry credentials — intercepted by the API proxy, never passed to the sandbox */
const CREDENTIAL_ENV_VARS = new Set(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Build the bwrap argument array for a given proxy port and options.
 */
function buildBwrapArgs(
  options: SandboxRuntimeOptions,
  innerCommand: string[],
  proxyPort: number,
  apiProxyPort: number,
  sanitizedClaudeJsonPath: string | null,
): string[] {
  const { worktreePath, repoGitDir, extraReadPaths, extraWritePaths, env } = options;
  const home = process.env.HOME ?? "/root";

  const args: string[] = ["bwrap"];

  // System directories — ro-bind or symlink depending on host layout
  for (const path of SYSTEM_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        // e.g. /bin -> usr/bin: replicate as a symlink inside the sandbox
        const target = readlinkSync(path, "utf-8");
        args.push("--symlink", target, path);
      } else {
        args.push("--ro-bind", path, path);
      }
    } catch {
      args.push("--ro-bind", path, path);
    }
  }

  // Proc and dev
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");

  // Namespace isolation
  args.push("--unshare-pid");
  args.push("--unshare-ipc");

  // Tmpfs for /tmp (writable but ephemeral, not the host's /tmp)
  args.push("--tmpfs", "/tmp");

  // Home directory read-only mounts — only specific paths, not all of $HOME
  const homeMounts = new Set<string>();

  const addHomeMount = (path: string) => {
    if (homeMounts.has(path)) return;
    homeMounts.add(path);
    if (existsSync(path)) {
      args.push("--ro-bind", path, path);
    }
  };

  // Claude Code config — needs read-write for session state, conversations,
  // hooks, and config saves. This is a known security tradeoff: a compromised
  // agent could inject hooks or modify settings. The claude-config-guard
  // module monitors for such tampering at the dashboard level.
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    homeMounts.add(claudeDir);
    args.push("--bind", claudeDir, claudeDir);

    // Mask credential files within ~/.claude/ — bind an empty temp file over
    // them so the sandbox sees no tokens. Real credentials are injected by the
    // API proxy running on the host side.
    for (const credFile of [".credentials.json", "agent-oauth-token"]) {
      const fullPath = join(claudeDir, credFile);
      if (existsSync(fullPath)) {
        // Use /dev/null — writes are silently discarded, reads return empty
        args.push("--bind", "/dev/null", fullPath);
      }
    }
  }

  // ~/.claude.json — bind a sanitized copy (no primaryApiKey, no oauthAccount)
  // at the original path. Real credentials are injected by the API proxy.
  const claudeJson = join(home, ".claude.json");
  const claudeJsonSource = sanitizedClaudeJsonPath ?? claudeJson;
  if (existsSync(claudeJsonSource)) {
    args.push("--bind", claudeJsonSource, claudeJson);
  }

  // Specific ~/.config sub-paths needed by tools (git, gh, deer).
  // Avoids exposing the entire ~/.config which contains unrelated secrets.
  for (const sub of ["git", "gh", "deer"]) {
    addHomeMount(join(home, ".config", sub));
  }

  // Mount PATH directories under HOME so sandboxed tools are found.
  // Mounts the specific directory (e.g. ~/.local/bin) rather than the
  // top-level parent (e.g. ~/.local) to avoid exposing unrelated data.
  // Also resolves symlinks in those dirs and mounts their real targets,
  // since binaries like `claude` may be symlinks to versioned paths
  // (e.g. ~/.local/bin/claude -> ~/.local/share/claude/versions/X).
  if (process.env.PATH) {
    const homePrefix = home + "/";
    for (const dir of process.env.PATH.split(":")) {
      if (!dir.startsWith(homePrefix)) continue;
      addHomeMount(dir);

      // Resolve symlink targets in this PATH dir
      try {
        for (const entry of readdirSync(dir)) {
          const entryPath = join(dir, entry);
          try {
            const stat = lstatSync(entryPath);
            if (stat.isSymbolicLink()) {
              const realPath = realpathSync(entryPath);
              if (realPath.startsWith(homePrefix)) {
                // Mount the directory containing the real binary
                addHomeMount(dirname(realPath));
              }
            }
          } catch { /* skip broken symlinks */ }
        }
      } catch { /* skip unreadable dirs */ }
    }
  }

  // Extra read-only paths
  if (extraReadPaths) {
    for (const path of extraReadPaths) {
      if (existsSync(path)) {
        args.push("--ro-bind", path, path);
      }
    }
  }

  // Extra read-write paths
  if (extraWritePaths) {
    for (const path of extraWritePaths) {
      if (existsSync(path)) {
        args.push("--bind", path, path);
      }
    }
  }

  // Main repo's .git/ directory — needed for git worktree operations.
  if (repoGitDir && existsSync(repoGitDir)) {
    args.push("--ro-bind", repoGitDir, repoGitDir);
  }

  // Worktree: the only persistent writable mount.
  // Must come after all read-only mounts so it overlays any parent ro-bind
  // (e.g. worktree under ~/.local/share/deer is inside the ~/.local ro-bind).
  args.push("--bind", worktreePath, worktreePath);

  // Process isolation
  args.push("--die-with-parent");
  args.push("--chdir", worktreePath);

  // Environment: CONNECT proxy settings for network allowlisting
  if (proxyPort > 0) {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    args.push("--setenv", "HTTPS_PROXY", proxyUrl);
    args.push("--setenv", "HTTP_PROXY", proxyUrl);
  }

  // API proxy: redirect all Anthropic API calls to the host-side proxy that injects
  // real credentials. The sandbox gets a dummy key so Claude Code can start, but it
  // is not a real credential — the proxy strips it and substitutes the host's real key.
  if (apiProxyPort > 0) {
    args.push("--setenv", "ANTHROPIC_BASE_URL", `http://127.0.0.1:${apiProxyPort}`);
    args.push("--setenv", "ANTHROPIC_API_KEY", "deer-proxy-key");
  }

  // Custom environment variables — credential vars are intercepted for the API
  // proxy and must never be forwarded directly into the sandbox.
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (CREDENTIAL_ENV_VARS.has(key)) continue;
      args.push("--setenv", key, value);
    }
  }

  // Preserve HOME so Claude Code finds its config
  args.push("--setenv", "HOME", home);

  // Unset CLAUDECODE so nested Claude instances don't refuse to start
  args.push("--unsetenv", "CLAUDECODE");

  // Preserve PATH so sandboxed tools (claude, git, gh, etc.) are found
  if (process.env.PATH) {
    args.push("--setenv", "PATH", process.env.PATH);
  }

  // Preserve TERM so interactive TUI applications render correctly
  args.push("--setenv", "TERM", process.env.TERM ?? "xterm-256color");

  // Separator + inner command
  args.push("--");
  args.push(...innerCommand);

  return args;
}

/**
 * Create a bwrap sandbox runtime instance.
 *
 * Each call creates a fresh runtime with its own proxy lifecycle.
 * The proxy starts in prepare() and stops when the returned cleanup runs.
 *
 * Uses mount namespaces for filesystem isolation and a CONNECT proxy
 * for network allowlisting. The proxy runs host-side; the sandbox only
 * sees HTTP_PROXY/HTTPS_PROXY pointing at 127.0.0.1:<port>.
 *
 * Advantages over nono/Landlock:
 * - Path-based (no inode issues with atomic writes or backup files)
 * - Isolated /tmp (tmpfs, not shared with host)
 * - Works on kernel 3.8+ (vs 5.13+ for Landlock)
 *
 * Requires: bwrap binary in PATH.
 */
export function createBwrapRuntime(): SandboxRuntime {
  let proxyPort = 0;
  let apiProxyPort = 0;
  let sanitizedClaudeJsonPath: string | null = null;

  return {
    name: "bwrap",

    async prepare(options: SandboxRuntimeOptions): Promise<SandboxCleanup> {
      const credentials = await readHostCredentials(options.env);

      const [proxy, apiProxy] = await Promise.all([
        startProxy({ allowlist: options.allowlist }),
        startApiProxy({ credentials }),
      ]);
      proxyPort = proxy.port;
      apiProxyPort = apiProxy.port;

      // Create a sanitized ~/.claude.json without credential fields
      const home = process.env.HOME ?? "/root";
      const claudeJsonPath = join(home, ".claude.json");
      if (existsSync(claudeJsonPath)) {
        sanitizedClaudeJsonPath = await createSanitizedClaudeJson(claudeJsonPath);
      }

      return async () => {
        proxy.stop();
        apiProxy.stop();
        proxyPort = 0;
        apiProxyPort = 0;
        if (sanitizedClaudeJsonPath) {
          await rm(sanitizedClaudeJsonPath, { force: true }).catch(() => {});
          sanitizedClaudeJsonPath = null;
        }
      };
    },

    buildCommand(options: SandboxRuntimeOptions, innerCommand: string[]): string[] {
      return buildBwrapArgs(options, innerCommand, proxyPort, apiProxyPort, sanitizedClaudeJsonPath);
    },
  };
}
