export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

export async function runPreflight(): Promise<PreflightResult> {
  const errors: string[] = [];

  // Check nono
  try {
    const p = Bun.spawn(["nono", "--version"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("nono not available — install from https://nono.sh");
  } catch {
    errors.push("nono not available — install from https://nono.sh");
  }

  // Check tmux
  try {
    const p = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("tmux not available");
  } catch {
    errors.push("tmux not available");
  }

  // Check claude
  try {
    const p = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("claude CLI not available");
  } catch {
    errors.push("claude CLI not available");
  }

  // Check gh auth
  try {
    const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0) errors.push("gh auth not configured — run 'gh auth login'");
  } catch {
    errors.push("gh CLI not available");
  }

  // Check OAuth token
  const tokenFile = `${process.env.HOME ?? ""}/.claude/agent-oauth-token`;
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const f = Bun.file(tokenFile);
      if (await f.exists()) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = (await f.text()).trim();
      }
    } catch { /* ignore */ }
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    errors.push("No OAuth token — set CLAUDE_CODE_OAUTH_TOKEN or create ~/.claude/agent-oauth-token");
  }

  return { ok: errors.length === 0, errors };
}
