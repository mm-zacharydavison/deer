/**
 * Tests for host environment variable filtering.
 *
 * default: strips curated exact-name credential list
 * high: additionally strips vars matching credential keyword patterns by name
 */
import { test, expect, describe } from "bun:test";
import { defaultSecurity } from "../../packages/deerbox/src/sandbox/security/default";
import { highSecurity } from "../../packages/deerbox/src/sandbox/security/high";

describe("defaultSecurity.filterEnv", () => {
  test("strips exact credential env var names", () => {
    const result = defaultSecurity.filterEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-real",
        GITHUB_TOKEN: "ghp_real",
        NPM_TOKEN: "npm_real",
        AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        JWT_SECRET: "my-jwt-secret",
        DATABASE_URL: "postgres://user:pass@host/db",
        PATH: "/usr/bin:/bin",
        GOPATH: "/home/user/go",
        NODE_ENV: "production",
      },
    );

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.NPM_TOKEN).toBeUndefined();
    expect(result.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.JWT_SECRET).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();

    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.GOPATH).toBe("/home/user/go");
    expect(result.NODE_ENV).toBe("production");
  });

  test("preserves pattern-matched vars that are not in the exact list", () => {
    const result = defaultSecurity.filterEnv({
      MY_API_KEY: "custom-key",
      PLEX_ZD_PLEX_TOKEN: "plex-token",
      CUSTOM_SECRET: "my-secret",
    });

    expect(result.MY_API_KEY).toBe("custom-key");
    expect(result.PLEX_ZD_PLEX_TOKEN).toBe("plex-token");
    expect(result.CUSTOM_SECRET).toBe("my-secret");
  });

  test("skips undefined values", () => {
    const result = defaultSecurity.filterEnv(
      { DEFINED: "value", UNDEFINED_VAR: undefined },
    );

    expect(result.DEFINED).toBe("value");
    expect("UNDEFINED_VAR" in result).toBe(false);
  });
});

describe("highSecurity.filterEnv", () => {
  test("strips exact credential env var names", () => {
    const result = highSecurity.filterEnv(
      { ANTHROPIC_API_KEY: "sk-ant-real", PATH: "/usr/bin:/bin" },
    );

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.PATH).toBe("/usr/bin:/bin");
  });

  test("strips vars matching credential keyword pattern by name", () => {
    const result = highSecurity.filterEnv({
      MY_API_KEY: "custom-key",
      PLEX_ZD_PLEX_TOKEN: "plex-token",
      GITHUB_NPM_TOKEN: "ghp_npm",
      CUSTOM_SECRET: "mysecret",
      CUSTOM_PASSWORD: "mypass",
      PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
      DB_PASSWORD: "dbpass",
      MY_CLIENT_SECRET: "oauth-secret",
    });

    expect(result.MY_API_KEY).toBeUndefined();
    expect(result.PLEX_ZD_PLEX_TOKEN).toBeUndefined();
    expect(result.GITHUB_NPM_TOKEN).toBeUndefined();
    expect(result.CUSTOM_SECRET).toBeUndefined();
    expect(result.CUSTOM_PASSWORD).toBeUndefined();
    expect(result.PRIVATE_KEY).toBeUndefined();
    expect(result.DB_PASSWORD).toBeUndefined();
    expect(result.MY_CLIENT_SECRET).toBeUndefined();
  });

  test("does not strip non-credential vars", () => {
    const result = highSecurity.filterEnv({
      PATH: "/usr/bin:/bin",
      GOPATH: "/home/user/go",
      NODE_ENV: "production",
      LANG: "en_US.UTF-8",
      UV_CACHE_DIR: "/home/user/.cache/uv",
      TOKEN_EXPIRY_SECONDS: "3600",
      SECRET_SCANNING_ENABLED: "true",
      FORCE_COLORS: "1",
      COLORTERM: "truecolor",
      PNPM_HOME: "/home/user/.local/share/pnpm",
    });

    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.GOPATH).toBe("/home/user/go");
    expect(result.NODE_ENV).toBe("production");
    expect(result.LANG).toBe("en_US.UTF-8");
    expect(result.UV_CACHE_DIR).toBe("/home/user/.cache/uv");
    // These contain credential keywords but NOT at end after underscore
    expect(result.TOKEN_EXPIRY_SECONDS).toBe("3600");
    expect(result.SECRET_SCANNING_ENABLED).toBe("true");
    expect(result.FORCE_COLORS).toBe("1");
    expect(result.COLORTERM).toBe("truecolor");
    expect(result.PNPM_HOME).toBe("/home/user/.local/share/pnpm");
  });

  test("strips vars when credential keyword is the entire name", () => {
    const result = highSecurity.filterEnv(
      { TOKEN: "some-token", SECRET: "some-secret", PASSWORD: "some-pass" },
    );

    expect(result.TOKEN).toBeUndefined();
    expect(result.SECRET).toBeUndefined();
    expect(result.PASSWORD).toBeUndefined();
  });
});
