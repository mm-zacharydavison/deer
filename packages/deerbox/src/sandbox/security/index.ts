import type { SecurityLevel } from "../../config";
import { defaultSecurity } from "./default";
import { highSecurity } from "./high";

/**
 * Controls how the sandbox filters host environment variables and which
 * additional filesystem paths are added to the SRT denyRead list.
 *
 * Each security level is a self-contained strategy — see the individual
 * files for the exact rules applied at each level.
 */
export interface SecurityStrategy {
  /**
   * Filter host environment variables, stripping those whose names indicate
   * they hold credentials. Returns a new object; the input is not mutated.
   *
   * @param env - Source environment (typically `process.env`)
   * @param allowlist - Env var names to pass through even if they match the blocked list
   */
  filterEnv(env: Record<string, string | undefined>, allowlist?: string[]): Record<string, string>;

  /**
   * Return additional filesystem paths to append to the sandbox's denyRead
   * list, beyond what the default home-directory enumeration covers.
   *
   * @param home - The user's home directory
   */
  extraDenyRead(home: string): string[];
}

export function resolveSecurityStrategy(level: SecurityLevel): SecurityStrategy {
  switch (level) {
    case "high":
      return highSecurity;
    case "default":
      return defaultSecurity;
  }
}
