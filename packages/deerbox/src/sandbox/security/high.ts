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
 * any var whose name matches a credential keyword pattern ending. An optional
 * allowlist overrides blocked names at both levels.
 *
 * Filesystem: delegates to defaultSecurity (system credential files, root home,
 * other users' home dirs, password manager dirs).
 */
export const highSecurity: SecurityStrategy = {
  filterEnv(env, allowlist = []) {
    const allowed = new Set(allowlist);
    const base = defaultSecurity.filterEnv(env, allowlist);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
      if (CREDENTIAL_ENV_HIGH_PATTERN.test(key) && !allowed.has(key)) continue;
      result[key] = value;
    }
    return result;
  },

  extraDenyRead(home) {
    return defaultSecurity.extraDenyRead(home);
  },
};
