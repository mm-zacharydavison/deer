# Deer — Code Review & Refactoring Recommendations

This document covers the completed portions of the codebase (Phase 0 scaffolding + Phase 1 input/git modules). Stub files are excluded since they contain no logic yet.

---

## 1. Bugs & Correctness Issues

### 1.1 `dataDir()` silently produces a broken path when `HOME` is unset

**File:** `src/task.ts:56`

```ts
export function dataDir(): string {
  const home = process.env.HOME;
  return `${home}/.local/share/deer`;
}
```

If `HOME` is unset, this returns `"undefined/.local/share/deer"` — a silently wrong path. Since `dataDir()` is called from `createWorktree()` and will be called from persistence code, it should fail loudly.

**Recommendation:**
```ts
export function dataDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  return `${home}/.local/share/deer`;
}
```

---

### 1.2 `withGitLock` can spin forever on a stale lock

**File:** `src/git/sync.ts:18-34`

The spin-wait has no timeout. If a process dies while holding `.git/deer.lock`, all subsequent callers loop indefinitely with no way to recover. This is a reliability hazard for an automated agent.

**Recommendation:** Add a max-wait deadline and stale-lock detection (e.g., check `mtime` of the lock directory):

```ts
const LOCK_TIMEOUT_MS = 30_000;
const started = Date.now();
while (true) {
  try {
    await mkdir(lockPath, { recursive: false });
    break;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        // Stale lock — remove and retry once
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    throw err;
  }
}
```

---

### 1.3 `removeWorktree` does not delete the associated branch

**File:** `src/git/worktree.ts:125-137`

`git worktree remove` removes the working directory and the worktree registration, but does **not** delete the `deer/<taskId>` branch ref. Over time this accumulates dead branches.

**Recommendation:** After removing the worktree, delete the branch:
```ts
await Bun.$`git -C ${repoPath} branch -d deer/${taskId}`.quiet().nothrow();
```
This requires threading `taskId` into `removeWorktree`, or alternatively extracting the branch name from the worktree before removing it.

---

### 1.4 `fetchWebPage` does not validate Content-Type

**File:** `src/input/web.ts:51-59`

If a URL returns a PDF, binary, or JSON response, `extractReadableContent` will receive garbage and return mangled text with no error. The agent will then run with a nonsensical instruction.

**Recommendation:** Check the `Content-Type` header before parsing:
```ts
const contentType = response.headers.get("content-type") ?? "";
if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
  throw new Error(`Unsupported content type for ${url}: ${contentType}`);
}
```

---

### 1.5 `finalizeWorktree` commits with a static message

**File:** `src/git/worktree.ts:111`

```ts
await Bun.$`git -C ${worktreePath} commit -m "deer: automated changes"`.quiet();
```

Every commit from every task has the same message. This makes `git log` useless for auditing. A task ID or summary should be included.

**Recommendation:** Accept an optional `message` parameter, defaulting to something that includes the task context (at minimum the branch name which contains the task ID).

---

## 2. Type Safety

### 2.1 `config.ts` — excessive `as unknown as` casts

**File:** `src/config.ts:159-177`

```ts
config = deepMerge(
  config as unknown as Record<string, unknown>,
  globalConfig as Record<string, unknown>
) as unknown as DeerConfig;
```

This pattern appears three times. It signals that `deepMerge`'s untyped signature is fighting the typed `DeerConfig`. The type system provides no guarantee the result is actually a valid `DeerConfig`.

**Recommendation:** Type `deepMerge` as a generic that preserves structure, or replace the general-purpose merge with typed per-section merges. At minimum, add a runtime validation step after merging, or use a schema library like `zod` to parse and validate the final config.

---

### 2.2 `tomlToConfig` does not validate field types

**File:** `src/config.ts:186-218`

Fields from TOML are cast without checking their runtime types. For example:
```ts
...(network.allowlist !== undefined && { allowlist: network.allowlist }),
```
If a user writes `allowlist = "github.com"` (a string instead of an array), the config would silently contain a string where an array is expected, causing a runtime crash later.

**Recommendation:** Add type guards or use a schema validator. At minimum:
```ts
if (Array.isArray(network.allowlist)) {
  result.network = { allowlist: network.allowlist as string[] };
}
```

---

### 2.3 `GitHubIssueData` interface is ambiguous about comment author shape

**File:** `src/input/github.ts:7-11`

The public `GitHubIssueData` interface has `comments: Array<{ author: string; body: string }>` (flat string), but the raw `gh` JSON has `author: { login: string }`. The transformation happens correctly at line 77, but the inconsistency between the internal type (lines 68-72) and the exported type is a potential source of confusion for future implementors.

**Recommendation:** Export a `GitHubCommentRaw` internal type and keep `GitHubIssueData` as the clean external shape; document the transformation clearly.

---

## 3. Design & Architecture

### 3.1 Two parallel TOML-to-config paths with different field mappings

**File:** `src/config.ts`

There are two functions that both map TOML fields to `DeerConfig`:
- `tomlToConfig()` — handles global config (snake_case → camelCase)
- `applyRepoLocal()` — handles repo-local config (snake_case → nested DeerConfig)

They share the same field names (`base_branch`, `setup_command`) but use different code paths, increasing maintenance surface. Adding a new field requires updating both functions.

**Recommendation:** Unify these under a single schema-driven mapping, or extract a shared `mapCommonFields(toml)` helper that both call.

---

### 3.2 `detectInputType` file detection is limited to `.md` and `.txt`

**File:** `src/input/detect.ts:24`

```ts
if (/\.(md|txt)$/.test(input)) {
```

This seems unnecessarily restrictive. A user might reasonably pass a `.rst`, `.adoc`, or even a file without an extension. The check's real purpose is to avoid treating a short path string as a URL when the file doesn't exist — but this heuristic is imprecise.

**Recommendation:** Consider expanding to any file path (starting with `/`, `./`, or `~/`), and fall back to text only if the file doesn't exist:
```ts
if (input.startsWith("/") || input.startsWith("./") || input.startsWith("~/")) {
  const resolved = input.replace(/^~/, process.env.HOME ?? "~");
  if (await Bun.file(resolved).exists()) {
    return { kind: "file", path: resolved };
  }
}
```

---

### 3.3 `globalConfigPath` falls back to `""` when `HOME` is unset

**File:** `src/config.ts:155`

```ts
const globalPath = globalConfigPath ?? join(process.env.HOME ?? "", ".config", "deer", "config.toml");
```

`HOME ?? ""` produces `".config/deer/config.toml"` (a relative path) rather than failing. This is inconsistent with the explicit error recommended for `dataDir()`, and would silently look for a config in the process's current directory.

**Recommendation:** Use the same guard as `dataDir()`, or check `HOME` once at startup and make it available throughout.

---

### 3.4 `detectRepo` default branch fallback checks `main` but not `master`'s existence

**File:** `src/git/worktree.ts:56-58`

```ts
const mainCheck = await Bun.$`git -C ${repoPath} show-ref --verify --quiet refs/heads/main`.quiet().nothrow();
defaultBranch = mainCheck.exitCode === 0 ? "main" : "master";
```

If neither `main` nor `master` exists (e.g., the repo uses `trunk`, `develop`, or `release`), this silently falls back to `"master"` and `createWorktree` will fail with a confusing error.

**Recommendation:** If `main` doesn't exist, also verify `master` exists before selecting it, and throw a descriptive error if neither is found, suggesting the user set `baseBranch` explicitly in `deer.toml`.

---

### 3.5 `extractReadableContent` is regex-based HTML parsing

**File:** `src/input/web.ts:4-46`

Regex-based HTML stripping is fragile: it doesn't handle CDATA sections, commented-out scripts, nested quotes in attributes, or non-standard tag syntax. It also only decodes 6 HTML entities, leaving `&mdash;`, `&hellip;`, `&#160;`, and numeric/hex entities intact.

Since Bun has native DOM parsing available via `HTMLRewriter`, consider using it for more robust extraction. Alternatively, if a full DOM is overkill, a library like `node-html-parser` (lightweight, no native deps) would be more reliable than regex.

---

## 4. Developer Experience & Tooling

### 4.1 No linter configured

The project has no ESLint, Biome, or other linter. With `strict: true` in `tsconfig.json`, type checking is enforced, but style issues and common mistakes (unused variables, implicit fallthrough, etc.) are not caught automatically.

**Recommendation:** Add Biome (zero-config, fast, replaces ESLint+Prettier for Bun projects):
```bash
bun add -d @biomejs/biome
bunx biome init
```
Add to `package.json`:
```json
"scripts": {
  "lint": "biome check src test",
  "format": "biome format --write src test"
}
```

---

### 4.2 No `typecheck` script

There is no script for running `tsc --noEmit`, so type errors are only surfaced if someone runs the TypeScript compiler manually. CI and the developer loop have no automated type checking step.

**Recommendation:**
```json
"scripts": {
  "typecheck": "tsc --noEmit"
}
```

---

### 4.3 No CI configuration

There is no `.github/workflows/` or equivalent. Given this is an agent that will be creating PRs, having automated tests run on pull requests is especially important.

**Recommendation:** Add a minimal GitHub Actions workflow:
```yaml
# .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run typecheck
      - run: bun test
```

---

### 4.4 `bin` entry in `package.json` points to a TypeScript file

**File:** `package.json`

```json
"bin": { "deer": "src/cli.ts" }
```

This works with Bun directly, but won't work if the package is ever published to npm or installed via npm/npx. The bin entry should point to the compiled output (`dist/src/cli.js`) when distributing.

This is acceptable while the project is local-only, but worth noting for when distribution is considered.

---

## 5. Minor Issues

### 5.1 `generateTaskId` suffix is over-generated and sliced

**File:** `src/task.ts:44-47`

```ts
const suffix = Array.from(random)
  .map((b) => b.toString(36).padStart(2, "0"))
  .join("")
  .slice(0, 8);
```

6 bytes × 2 chars = 12 characters are generated, then truncated to 8. This wastes 4 characters of entropy that were already computed. Either generate exactly the right number of bytes (4 bytes → 8 chars max, but base36 padding can vary), or keep 12 chars for more uniqueness. The current approach is correct but slightly wasteful.

---

### 5.2 `finalizeWorktree` re-reads HEAD to get the branch name

**File:** `src/git/worktree.ts:114-116`

The branch name is already known at `createWorktree` time (it's `deer/${taskId}`). Re-reading `HEAD` in `finalizeWorktree` is unnecessary and adds a round-trip. Consider threading the branch name through or computing it from a known task ID.

---

### 5.3 `Task.repoRemote` example in JSDoc omits scheme

**File:** `src/task.ts:8`

```ts
/** @example "github.com/org/repo" */
repoRemote: string;
```

`git remote get-url origin` typically returns either `https://github.com/org/repo` (HTTPS) or `git@github.com:org/repo` (SSH). The example format matches neither and would need normalization when used to construct GitHub API URLs or PR links.

Consider either storing the raw remote URL and normalizing at use sites, or explicitly normalizing to a canonical form (`github.com/org/repo`) when building the `Task` object, with a note in the JSDoc about what normalization is applied.

---

## Summary

| Priority | Issue | File |
|----------|-------|------|
| High | `dataDir()` silent failure on unset `HOME` | `src/task.ts` |
| High | Infinite spin on stale git lock | `src/git/sync.ts` |
| High | No Content-Type check in `fetchWebPage` | `src/input/web.ts` |
| Medium | Orphaned branches after `removeWorktree` | `src/git/worktree.ts` |
| Medium | Static commit message loses task context | `src/git/worktree.ts` |
| Medium | `as unknown as` type cast proliferation | `src/config.ts` |
| Medium | TOML fields not runtime-validated | `src/config.ts` |
| Medium | Default branch fallback silently picks `master` | `src/git/worktree.ts` |
| Medium | Duplicate TOML mapping logic | `src/config.ts` |
| Low | File detection limited to `.md`/`.txt` | `src/input/detect.ts` |
| Low | No linter configured | project root |
| Low | No `typecheck` script | `package.json` |
| Low | No CI configuration | project root |
| Low | Regex HTML parsing is fragile | `src/input/web.ts` |
