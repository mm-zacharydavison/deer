import { checkAndUpdate } from "@deer/shared";
import pkg from "../package.json";

export { checkAndUpdate };

/** Pre-bound updater for the deer TUI binary. */
export function checkAndUpdateDeer(): Promise<boolean> {
  return checkAndUpdate({ name: "deer", version: pkg.version });
}
