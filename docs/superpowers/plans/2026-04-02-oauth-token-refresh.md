# OAuth Token Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the MITM auth proxy receives a 401 from upstream, it re-reads OAuth credentials from host sources, updates its in-memory headers, and retries the request transparently so Claude never sees an auth failure.

**Architecture:** `ProxyUpstream` gains an optional `oauthRefresh` field describing where to read OAuth credentials. The proxy server buffers every request body before forwarding, and on 401 calls a `refreshToken()` function that re-reads credentials from those sources, updates the upstream's headers in memory, then retries once. Concurrent 401s serialize via a per-domain promise lock so only one credential read happens. `proxy.ts` populates `oauthRefresh` for the Anthropic upstream when the winning credential is OAuth.

**Tech Stack:** Bun, Node.js, TypeScript, bun:test

---

## File Map

| File | Change |
|------|--------|
| `packages/deerbox/src/sandbox/auth-proxy.ts` | Add `CredentialSource`, `OAuthRefresh` types; add `oauthRefresh?` to `ProxyUpstream` |
| `packages/deerbox/src/proxy.ts` | Import `join`, `HOME`; populate `oauthRefresh` on Anthropic upstream when credential is OAuth |
| `packages/deerbox/src/sandbox/auth-proxy-server.mjs` | Add `collectBody`, `resolveTokenFromSources`, `refreshToken`; make handler async; buffer bodies; retry on 401 |
| `test/sandbox/auth-proxy.test.ts` | Add four new tests: transparent retry, pass-through 401 (no refresh), pass-through 401 (refresh fails), concurrent 401 serialization |

---

## Task 1: Add `oauthRefresh` types to `ProxyUpstream`

**Files:**
- Modify: `packages/deerbox/src/sandbox/auth-proxy.ts`

- [ ] **Step 1: Add types**

In `packages/deerbox/src/sandbox/auth-proxy.ts`, add before the `ProxyUpstream` interface:

```typescript
export type CredentialSource =
  | { type: "agent-token-file"; path: string }
  | { type: "keychain"; service: string }
  | { type: "file"; paths: string[] };

export interface OAuthRefresh {
  /** Ordered credential sources — first match wins */
  sources: CredentialSource[];
  /** Header name to inject (e.g. "authorization") */
  headerName: string;
  /** Template with `${token}` placeholder (e.g. "Bearer ${token}") */
  headerTemplate: string;
}
```

Then add to `ProxyUpstream`:

```typescript
  /**
   * If present, enables transparent 401 retry with token refresh.
   * Only set for OAuth-authenticated upstreams (not API key upstreams).
   */
  oauthRefresh?: OAuthRefresh;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
bun run build 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/deerbox/src/sandbox/auth-proxy.ts
git commit -m "feat: add oauthRefresh type to ProxyUpstream"
```

---

## Task 2: Write failing tests for 401 refresh behaviour

**Files:**
- Modify: `test/sandbox/auth-proxy.test.ts`

- [ ] **Step 1: Add `proxyPost` helper and four new tests**

Add these after the last existing test in `test/sandbox/auth-proxy.test.ts`, inside the `describe` block:

```typescript
  /** Send a POST request with a body through the proxy. */
  function proxyPost(
    socketPath: string,
    fullUrl: string,
    body: string,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const host = new URL(fullUrl).host;
      const bodyBuf = Buffer.from(body, "utf-8");
      const socket = connect(socketPath, () => {
        socket.write(
          `POST ${fullUrl} HTTP/1.1\r\n` +
            `Host: ${host}\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${bodyBuf.length}\r\n` +
            `Connection: close\r\n\r\n`,
        );
        socket.write(bodyBuf);
      });
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("end", () => {
        const [head, ...bodyParts] = data.split("\r\n\r\n");
        const statusLine = head.split("\r\n")[0];
        const status = parseInt(statusLine.split(" ")[1], 10);
        const bodyStr = bodyParts.join("\r\n\r\n");
        try {
          resolve({ status, body: JSON.parse(bodyStr) });
        } catch {
          resolve({ status, body: bodyStr });
        }
      });
      socket.on("error", reject);
    });
  }

  test("retries transparently on 401 using oauthRefresh agent-token-file", async () => {
    const dir = await makeTmpDir();
    const tokenFile = join(dir, "oauth-token");
    await Bun.write(tokenFile, "new-token-xyz");

    let callCount = 0;
    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((req, res) => {
        callCount++;
        if (callCount === 1) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("Unauthorized");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url, headers: req.headers }));
        }
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const socketPath = join(dir, "auth.sock");
    const upstream: ProxyUpstream = {
      domain: "api.example.com",
      target: `http://127.0.0.1:${port}`,
      headers: { authorization: "Bearer old-token" },
      oauthRefresh: {
        sources: [{ type: "agent-token-file", path: tokenFile }],
        headerName: "authorization",
        headerTemplate: "Bearer ${token}",
      },
    };

    const proxy = await startAuthProxy(socketPath, [upstream]);
    cleanups.push(() => proxy.close());

    const result = await proxyPost(socketPath, "http://api.example.com/v1/messages", '{"model":"claude"}');

    expect(result.status).toBe(200);
    expect(result.body.headers.authorization).toBe("Bearer new-token-xyz");
    expect(callCount).toBe(2);
  });

  test("passes 401 through when upstream has no oauthRefresh", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("Unauthorized");
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api.example.com",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer token" },
        // no oauthRefresh
      },
    ]);
    cleanups.push(() => proxy.close());

    const result = await proxyRequest(socketPath, "http://api.example.com/v1/messages");
    expect(result.status).toBe(401);
  });

  test("passes 401 through when all oauthRefresh sources fail", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("Unauthorized");
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api.example.com",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer token" },
        oauthRefresh: {
          sources: [{ type: "agent-token-file", path: join(dir, "nonexistent-token") }],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      },
    ]);
    cleanups.push(() => proxy.close());

    const result = await proxyRequest(socketPath, "http://api.example.com/v1/messages");
    expect(result.status).toBe(401);
  });

  test("concurrent 401s trigger only one token refresh", async () => {
    const dir = await makeTmpDir();
    const tokenFile = join(dir, "oauth-token");
    await Bun.write(tokenFile, "refreshed-token");

    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((req, res) => {
        const auth = req.headers["authorization"] ?? "";
        if (auth.includes("old-token")) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("Unauthorized");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url, headers: req.headers }));
        }
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const socketPath = join(dir, "auth.sock");
    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api.example.com",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer old-token" },
        oauthRefresh: {
          sources: [{ type: "agent-token-file", path: tokenFile }],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      },
    ]);
    cleanups.push(() => proxy.close());

    // Fire two requests concurrently
    const [r1, r2] = await Promise.all([
      proxyPost(socketPath, "http://api.example.com/v1/messages", "{}"),
      proxyPost(socketPath, "http://api.example.com/v1/messages", "{}"),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.headers.authorization).toBe("Bearer refreshed-token");
    expect(r2.body.headers.authorization).toBe("Bearer refreshed-token");
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test --cwd . test/sandbox/auth-proxy.test.ts 2>&1 | tail -30
```

Expected: the four new tests fail (existing tests still pass).

- [ ] **Step 3: Commit**

```bash
git add test/sandbox/auth-proxy.test.ts
git commit -m "test: add failing tests for 401 transparent token refresh"
```

---

## Task 3: Implement 401 refresh in `auth-proxy-server.mjs`

**Files:**
- Modify: `packages/deerbox/src/sandbox/auth-proxy-server.mjs`

- [ ] **Step 1: Add imports**

After the existing imports at the top of `packages/deerbox/src/sandbox/auth-proxy-server.mjs`, add:

```javascript
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
```

- [ ] **Step 2: Add helpers before `socketPath` line**

After the `httpAgent`/`httpsAgent` lines and before `const socketPath = process.argv[2];`, insert:

```javascript
/** Collect all request body chunks into a single Buffer. */
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Try each credential source in order, return the first OAuth token found.
 * Returns null if no source yields a token.
 */
function resolveTokenFromSources(sources) {
  for (const source of sources) {
    try {
      if (source.type === "agent-token-file") {
        const token = readFileSync(source.path, "utf-8").trim();
        if (token) return token;
      } else if (source.type === "keychain") {
        const raw = execSync(
          `security find-generic-password -s "${source.service}" -w`,
          { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
        if (typeof token === "string" && token) return token;
      } else if (source.type === "file") {
        for (const filePath of source.paths) {
          try {
            const token = JSON.parse(readFileSync(filePath, "utf-8"))?.claudeAiOauth?.accessToken;
            if (typeof token === "string" && token) return token;
          } catch { /* try next path */ }
        }
      }
    } catch { /* try next source */ }
  }
  return null;
}

/** Per-domain in-flight refresh promises — serializes concurrent 401 retries. */
const refreshLocks = new Map();

/**
 * Re-read OAuth credentials for an upstream and update its in-memory headers.
 * If a refresh is already in progress for this domain, waits for it instead
 * of starting a second one.
 */
function refreshToken(upstream) {
  if (refreshLocks.has(upstream.domain)) {
    return refreshLocks.get(upstream.domain);
  }
  const promise = Promise.resolve().then(() => {
    const token = resolveTokenFromSources(upstream.oauthRefresh.sources);
    if (token) {
      upstream.headers[upstream.oauthRefresh.headerName] =
        upstream.oauthRefresh.headerTemplate.replace("${token}", token);
    }
    return token;
  }).finally(() => refreshLocks.delete(upstream.domain));
  refreshLocks.set(upstream.domain, promise);
  return promise;
}
```

- [ ] **Step 3: Replace `forwardToUpstream`**

Replace the entire existing `forwardToUpstream` function with the following. It now accepts `method` and `bodyBuffer` instead of piping from `req`, and handles 401 refresh+retry:

```javascript
function forwardToUpstream(upstream, path, method, res, bodyBuffer, isRetry) {
  const targetUrl = new URL(path, upstream.target);
  const startTime = Date.now();
  const isHttps = targetUrl.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  const fwdHeaders = {
    host: targetUrl.host,
    ...upstream.headers,
  };
  // We have the full body buffered, so set an accurate content-length
  // and remove transfer-encoding (no longer applicable).
  delete fwdHeaders["transfer-encoding"];
  if (bodyBuffer.length > 0) {
    fwdHeaders["content-length"] = String(bodyBuffer.length);
  }

  const proxyReq = doRequest(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: fwdHeaders,
      agent: isHttps ? httpsAgent : httpAgent,
    },
    (proxyRes) => {
      const elapsed = Date.now() - startTime;
      const connType = proxyReq.reusedSocket ? "reused" : "new";

      if (proxyRes.statusCode === 401 && !isRetry && upstream.oauthRefresh) {
        proxyRes.resume(); // drain and discard the 401 body
        refreshToken(upstream).then((token) => {
          if (token) {
            forwardToUpstream(upstream, path, method, res, bodyBuffer, true);
          } else {
            log(`[proxy] ${method} ${upstream.domain}${path} → 401 (refresh found no token)`);
            if (!res.headersSent) {
              res.writeHead(401, { "content-type": "text/plain" });
              res.end("auth-proxy: upstream 401 - no token found during refresh");
            }
          }
        }).catch((err) => {
          log(`[proxy] ${method} ${upstream.domain}${path} → 401 (refresh error: ${err.message})`);
          if (!res.headersSent) {
            res.writeHead(401, { "content-type": "text/plain" });
            res.end(`auth-proxy: upstream 401 - refresh error: ${err.message}`);
          }
        });
        return;
      }

      log(`[proxy] ${method} ${upstream.domain}${path} → ${proxyRes.statusCode} (${elapsed}ms, ${connType})`);
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    const elapsed = Date.now() - startTime;
    log(`[proxy] ${method} ${upstream.domain}${path} → 502 error (${elapsed}ms): ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`auth-proxy: upstream error: ${err.message}`);
    }
  });

  proxyReq.end(bodyBuffer);
}
```

- [ ] **Step 4: Replace `handleRequest`**

Replace the entire existing `handleRequest` function with an async version that buffers the body and passes `method` to `forwardToUpstream`:

```javascript
async function handleRequest(req, res) {
  const rawUrl = req.url ?? "/";
  const method = req.method ?? "GET";

  // Buffer the full request body before forwarding so we can replay it on retry.
  const bodyBuffer = await collectBody(req);

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    if (upstreams.length > 0) {
      forwardToUpstream(upstreams[0], rawUrl, method, res, bodyBuffer, false);
      return;
    }
    log(`[proxy] 502 invalid URL ${rawUrl}`);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("auth-proxy: invalid request URL");
    return;
  }

  const hostname = parsedUrl.hostname;
  const upstream = upstreams.find((u) => u.domain === hostname);
  if (!upstream) {
    log(`[proxy] 502 no upstream for ${hostname}`);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`auth-proxy: no upstream for ${hostname}`);
    return;
  }

  if (upstream.allowedPaths?.length) {
    const allowed = upstream.allowedPaths.some((pattern) => new RegExp(pattern).test(parsedUrl.pathname));
    if (!allowed) {
      log(`[proxy] 403 blocked path ${method} ${upstream.domain}${parsedUrl.pathname}`);
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("auth-proxy: path not allowed");
      return;
    }
  }

  const path = parsedUrl.pathname + parsedUrl.search;
  forwardToUpstream(upstream, path, method, res, bodyBuffer, false);
}
```

- [ ] **Step 5: Wrap `createServer` call to handle async errors**

Replace:

```javascript
const server = createServer(handleRequest);
```

With:

```javascript
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`auth-proxy: internal error: ${err.message}`);
    }
  });
});
```

- [ ] **Step 6: Run the new tests**

```bash
bun test --cwd . test/sandbox/auth-proxy.test.ts 2>&1 | tail -40
```

Expected: all tests pass including the four new ones.

- [ ] **Step 7: Run full test suite**

```bash
bun test --cwd . test/ 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/deerbox/src/sandbox/auth-proxy-server.mjs
git commit -m "feat: buffer request bodies and retry transparently on 401 with token refresh"
```

---

## Task 4: Populate `oauthRefresh` in `proxy.ts`

**Files:**
- Modify: `packages/deerbox/src/proxy.ts`

No new tests needed — this is wiring. The auth-proxy tests cover the refresh behaviour end-to-end.

- [ ] **Step 1: Add imports**

At the top of `packages/deerbox/src/proxy.ts`, add:

```typescript
import { join } from "node:path";
import { HOME } from "@deer/shared";
```

- [ ] **Step 2: Populate `oauthRefresh` for OAuth upstreams**

In `resolveProxyUpstreams()`, replace the `upstreams.push({...})` call with:

```typescript
    upstreams.push({
      domain: cred.domain,
      target: cred.target,
      headers,
      ...(cred.hostEnv.key === "CLAUDE_CODE_OAUTH_TOKEN" && {
        oauthRefresh: {
          sources: [
            { type: "agent-token-file" as const, path: join(HOME, ".claude", "agent-oauth-token") },
            ...(process.platform === "darwin"
              ? [{ type: "keychain" as const, service: "Claude Code-credentials" }]
              : []),
            {
              type: "file" as const,
              paths: [
                join(HOME, ".claude.json"),
                join(HOME, ".config", "claude", "config.json"),
                join(HOME, ".claude", ".credentials.json"),
              ],
            },
          ],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      }),
    });
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bun run build 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Run full test suite one final time**

```bash
bun test --cwd . test/ 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/deerbox/src/proxy.ts
git commit -m "feat: populate oauthRefresh for Anthropic OAuth upstream in proxy config"
```
