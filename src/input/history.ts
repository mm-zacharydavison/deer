import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, appendFile } from "fs/promises";

function historyDir(): string {
  return join(homedir(), ".local", "share", "deer", "history");
}

/** Returns the history file path for a given working directory. */
export function historyFilePath(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(historyDir(), hash);
}

/**
 * Loads history entries for the given CWD.
 * Returns entries newest-first, as expected by readline.
 */
export async function loadHistory(cwd: string): Promise<string[]> {
  try {
    const content = await readFile(historyFilePath(cwd), "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    return lines.reverse();
  } catch {
    return [];
  }
}

/**
 * Appends a new entry to the history file for the given CWD.
 * Creates the history directory if it doesn't exist.
 */
export async function appendHistory(cwd: string, entry: string): Promise<void> {
  await mkdir(historyDir(), { recursive: true });
  await appendFile(historyFilePath(cwd), entry + "\n");
}
