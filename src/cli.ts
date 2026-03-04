#!/usr/bin/env bun

import { promptForInput } from "./input/prompt.js";

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const task = args[0] ?? (await promptForInput(process.cwd()));
  if (!task) {
    process.exit(0);
  }
  // TODO(Phase 1): wire into pipeline
  console.log("Task:", task);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
