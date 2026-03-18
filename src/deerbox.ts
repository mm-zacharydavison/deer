#!/usr/bin/env bun

// Strip ANTHROPIC_API_KEY immediately — deerbox prefers CLAUDE_CODE_OAUTH_TOKEN.
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  delete process.env.ANTHROPIC_API_KEY;
}

import { detectRepo } from "./git/worktree.ts";
import { loadConfig } from "./config.ts";
import { resolveRuntime } from "./sandbox/resolve.ts";
import { resolveCredentials } from "./preflight.ts";
import { startAgent } from "./agent.ts";
import { setLang, detectLang } from "./i18n.ts";
import { VERSION } from "./constants.ts";

setLang(detectLang());

async function main() {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(`deerbox ${VERSION}`);
    return;
  }

  const credType = await resolveCredentials();
  if (credType === "none") {
    console.error(
      "Error: No credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.",
    );
    process.exit(1);
  }

  const cwd = process.cwd();

  let repoPath: string;
  let defaultBranch: string;
  try {
    const repo = await detectRepo(cwd);
    repoPath = repo.repoPath;
    defaultBranch = repo.defaultBranch;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const config = await loadConfig(repoPath);
  const runtime = resolveRuntime(config);
  const baseBranch = config.defaults.baseBranch ?? defaultBranch;

  // Positional arg (if any) becomes the initial prompt; omitting it starts interactively.
  const prompt = process.argv[2];

  const handle = await startAgent({ repoPath, prompt, baseBranch, config, runtime });

  await Bun.spawn(["tmux", "attach", "-t", handle.sessionName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;

  await handle.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
