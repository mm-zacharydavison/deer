import { join, dirname, basename } from "node:path";
import { readdirSync } from "node:fs";
import type { SecurityStrategy } from "./index";
import { defaultSecurity } from "./default";

/**
 * Pattern for high security: strip any env var whose name ends with a
 * credential keyword segment after `_` or at the start of the name.
 *
 * Anchored to end-of-string so vars like TOKEN_EXPIRY_SECONDS or
 * SECRET_SCANNING_ENABLED are preserved — those have the keyword in a
 * non-terminal position.
 *
 * Source: detect-secrets keyword plugin + gitleaks generic-api-key rule.
 */
const CREDENTIAL_ENV_HIGH_PATTERN =
  /(?:^|_)(?:API_KEY|API_TOKEN|API_SECRET|AUTH_KEY|AUTH_TOKEN|AUTH_SECRET|ACCESS_KEY|ACCESS_TOKEN|ACCESS_SECRET|SECRET_KEY|PRIVATE_KEY|PRIV_KEY|CLIENT_SECRET|SIGNING_KEY|ENCRYPTION_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDS)$/i;

/**
 * High security strategy.
 *
 * Env filtering: applies the default exact-name list, then additionally strips
 * any var whose name matches a credential keyword pattern ending.
 *
 * Filesystem extra denyRead:
 * - System credential files: /etc/shadow, /etc/sudoers, /etc/sudoers.d
 * - Root home: /root
 * - Other users' home directories under the same parent as $HOME
 * - Password manager data dirs under $HOME/.local/share (keyrings, gnome-keyring,
 *   pass, KeePassXC) — these sit inside the .local required root so are not
 *   covered by the standard home-directory enumeration
 */
export const highSecurity: SecurityStrategy = {
  filterEnv(env) {
    const base = defaultSecurity.filterEnv(env);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
      if (CREDENTIAL_ENV_HIGH_PATTERN.test(key)) continue;
      result[key] = value;
    }
    return result;
  },

  extraDenyRead(home) {
    const denied: string[] = [
      // System credential / privilege files
      "/etc/shadow",
      "/etc/sudoers",
      "/etc/sudoers.d",
      // Root's home directory
      "/root",
      // Sensitive dirs under .local/share — inside the required .local root
      // so not reachable by the standard first-level $HOME enumeration
      join(home, ".local", "share", "keyrings"),
      join(home, ".local", "share", "gnome-keyring"),
      join(home, ".local", "share", "pass"),
      join(home, ".local", "share", "org.keepassxc.KeePassXC"),
    ];

    // Deny sibling home directories so other users' files are not reachable
    const homeParent = dirname(home);
    const currentUsername = basename(home);
    if (homeParent !== home) {
      try {
        for (const name of readdirSync(homeParent)) {
          if (name !== currentUsername) {
            denied.push(join(homeParent, name));
          }
        }
      } catch { /* non-standard home layout or unreadable parent */ }
    }

    return denied;
  },
};
