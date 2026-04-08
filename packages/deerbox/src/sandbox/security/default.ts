import type { SecurityStrategy } from "./index";

/**
 * Curated list of exact env var names that are always credential-bearing.
 *
 * Sources: detect-secrets, gitleaks, truffleHog, Gitrob, Talisman, and
 * well-known service-specific names.
 *
 * Used by both the default and high strategies.
 */
export const CREDENTIAL_ENV_EXACT = new Set([
  // AWS
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  // Google / GCP
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_API_KEY",
  "GCLOUD_SERVICE_KEY",
  // Azure
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "ARM_CLIENT_SECRET",
  // Anthropic / OpenAI
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // GitHub / GitLab
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "GL_TOKEN",
  // Package registries
  "NPM_TOKEN",
  "PYPI_TOKEN",
  "NUGET_API_KEY",
  "RUBYGEMS_API_KEY",
  // Container registries
  "DOCKER_PASSWORD",
  "DOCKER_AUTH_CONFIG",
  "REGISTRY_PASSWORD",
  // Hosting / PaaS
  "HEROKU_API_KEY",
  "NETLIFY_AUTH_TOKEN",
  "VERCEL_TOKEN",
  "DIGITALOCEAN_TOKEN",
  // CDN / DNS / monitoring
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "DATADOG_API_KEY",
  "NEW_RELIC_LICENSE_KEY",
  "SENTRY_AUTH_TOKEN",
  // Messaging / comms
  "SLACK_TOKEN",
  "SLACK_WEBHOOK_URL",
  "DISCORD_TOKEN",
  "TWILIO_AUTH_TOKEN",
  "SENDGRID_API_KEY",
  // Payments
  "STRIPE_SECRET_KEY",
  "STRIPE_API_KEY",
  "COINBASE_API_KEY",
  // Databases
  "DATABASE_URL",
  "REDIS_URL",
  "REDIS_PASSWORD",
  "MONGO_URI",
  "POSTGRES_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "DB_PASSWORD",
  // Cryptographic / session keys
  "SSH_PRIVATE_KEY",
  "GPG_PRIVATE_KEY",
  "ENCRYPTION_KEY",
  "JWT_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
]);

/**
 * Default security strategy.
 *
 * Env filtering: strips the exact well-known credential env var name list.
 * Non-listed vars (GOPATH, UV_CACHE_DIR, NODE_ENV, …) pass through unchanged.
 *
 * Filesystem: no additional denyRead paths beyond the standard home-directory
 * enumeration that applies at all security levels.
 */
export const defaultSecurity: SecurityStrategy = {
  filterEnv(env) {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      if (CREDENTIAL_ENV_EXACT.has(key)) continue;
      result[key] = value;
    }
    return result;
  },

  extraDenyRead(_home) {
    return [];
  },
};
