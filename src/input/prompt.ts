import * as readline from "readline";
import { loadHistory, appendHistory } from "./history.js";

/**
 * Prompts the user for a task description with persistent history support.
 * History is scoped to the given working directory (defaults to process.cwd()).
 * Up/down arrows cycle through previous entries from the same directory.
 */
export async function promptForInput(cwd: string = process.cwd()): Promise<string> {
  const history = await loadHistory(cwd);

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      history,
      historySize: 1000,
    });

    rl.question("Task: ", async (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed) {
        await appendHistory(cwd, trimmed);
      }
      resolve(trimmed);
    });
  });
}
