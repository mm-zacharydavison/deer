<img width="919" height="228" alt="image" src="https://github.com/user-attachments/assets/2c1fca9f-3484-409f-b3b4-214edc0387a4" />

# kadai

1. Drop scripts into `.kadai/actions/`.
2. Run with `bunx kadai`.
3. Share them with your team in the repo.
4. Automatically make them discoverable by AI.

## Prerequisites

kadai requires [Bun](https://bun.sh) as its runtime.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Homebrew
brew install oven-sh/bun/bun

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

## Getting Started

```bash
bunx kadai
```

On first run, kadai creates a `.kadai/` directory with a sample action and config file. Run it again to open the interactive menu.

### Directory Structure

```
.kadai/
├── config.ts          # Optional configuration (env vars, actions dir)
└── actions/           # Your scripts live here
    ├── hello.sh
    ├── deploy.ts
    └── database/      # Subdirectories become categories
        ├── reset.sh
        └── seed.py
```

## Features

### Supported Runtimes

| Extension            | Runtime |
|----------------------|---------|
| `.sh`, `.bash`       | bash    |
| `.ts`, `.js`, `.mjs` | bun     |
| `.py`                | python  |
| `.tsx`               | ink     |

Shebangs are respected — if your script has `#!/usr/bin/env python3`, kadai uses that directly. Otherwise it finds the best available interpreter automatically (e.g. `uv run` before `python3` for `.py` files).

### Frontmatter

Add metadata as comments in the first 20 lines of any script:

```bash
#!/bin/bash
# kadai:name Deploy Staging
# kadai:emoji 🚀
# kadai:description Deploy the app to staging
# kadai:confirm true
```

For JS/TS, use `//` comments:

```typescript
// kadai:name Reset Database
// kadai:emoji 🗑️
// kadai:confirm true
```

| Key           | Type    | Description                                |
|---------------|---------|--------------------------------------------|
| `name`        | string  | Display name (inferred from filename if omitted) |
| `emoji`       | string  | Emoji prefix in menus                      |
| `description` | string  | Short description                          |
| `confirm`     | boolean | Require confirmation before running        |
| `hidden`      | boolean | Hide from menu (still runnable via CLI)    |
| `fullscreen`  | boolean | Use alternate screen buffer (`.tsx` only)  |

### Ink TUI Actions

`.tsx` files let you build interactive terminal UIs that render directly inside kadai. Export a default React component that receives `InkActionProps`:

```tsx
// kadai:name Todo List
// kadai:emoji ✅
// kadai:description Manage project tasks
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { InkActionProps } from "kadai/types";

export default function TodoList({ onExit }: InkActionProps) {
  const [items] = useState(["Buy groceries", "Write code"]);
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    if (input === "q") onExit();
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={item} color={i === cursor ? "cyan" : undefined}>
          {i === cursor ? "❯ " : "  "}{item}
        </Text>
      ))}
      <Text dimColor>↑↓ navigate  q quit</Text>
    </Box>
  );
}
```

Your component receives these props:

| Prop    | Type                       | Description                              |
|---------|----------------------------|------------------------------------------|
| `cwd`   | `string`                   | Working directory kadai was launched from |
| `env`   | `Record<string, string>`   | Environment variables from kadai config  |
| `args`  | `string[]`                 | Additional arguments passed to the action |
| `onExit`| `() => void`               | Call this to return to the kadai menu     |

By default, ink actions render inline within kadai's UI. Add `kadai:fullscreen true` to use the terminal's alternate screen buffer — the action takes over the full screen and restores the previous view on exit:

```tsx
// kadai:fullscreen true
```

See `.kadai/actions/` in this repo for working examples.

### Config

`.kadai/config.ts` lets you set environment variables injected into all actions:

```typescript
export default {
  env: {
    DATABASE_URL: "postgres://localhost:5432/myapp",
    APP_ENV: "development",
  },
};
```

## CLI

```bash
kadai                    # Interactive menu
kadai list --json        # List actions as JSON
kadai list --json --all  # Include hidden actions
kadai run <action-id>    # Run an action directly
kadai mcp                # Start MCP server (creates .mcp.json)
```

## AI

kadai is designed to work well with AI coding agents like Claude Code.

### MCP Server

kadai includes a built-in [MCP](https://modelcontextprotocol.io/) server that exposes your actions as tools. Any MCP-compatible client (Claude Code, Claude Desktop, etc.) can auto-discover and run your project's actions.

kadai will automatically configure a `.mcp.json` file in your project root so Claude can automatically discover any `kadai` actions you define.

```bash
kadai mcp
```

This creates the `.mcp.json` in your project root if it doesn't already exist (so `claude` will autodiscover it.)
It then starts the `mcp` server (this is the command `claude` uses to invoke `kadai` MCP.)

Each action becomes an MCP tool. Nested action IDs use `--` as a separator (e.g. `database/reset` becomes the tool `database--reset`) since MCP tool names don't allow slashes.

### JSON API

- `kadai list --json` gives agents a machine-readable list of available project actions
- `kadai run <action-id>` runs actions non-interactively (confirmation prompts auto-skip in non-TTY)
- Agents can discover what's available, then run the right action — no hardcoded commands

### Skill Installation

If your project uses Claude Code (has a `.claude/` directory or `CLAUDE.md`), kadai automatically creates a skill file at `.claude/skills/kadai/SKILL.md` on first run. This teaches Claude Code how to discover and run your project's actions.

The skill is non-user-invocable — Claude Code reads it automatically and uses kadai when relevant, without needing explicit prompts.
