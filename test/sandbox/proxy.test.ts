import { test, expect, describe, afterEach } from "bun:test";
import { startProxy, startApiProxy, matchesAllowlist, isPrivateIP, type ProxyHandle } from "../../src/sandbox/proxy";
import { createServer, type Server } from "node:net";

describe("matchesAllowlist", () => {
  test("exact match", () => {
    expect(matchesAllowlist("example.com", ["example.com"])).toBe(true);
  });

  test("case insensitive", () => {
    expect(matchesAllowlist("Example.COM", ["example.com"])).toBe(true);
  });

  test("no match", () => {
    expect(matchesAllowlist("evil.com", ["example.com"])).toBe(false);
  });

  test("wildcard matches subdomain", () => {
    expect(matchesAllowlist("sub.example.com", ["*.example.com"])).toBe(true);
  });

  test("wildcard matches deep subdomain", () => {
    expect(matchesAllowlist("a.b.example.com", ["*.example.com"])).toBe(true);
  });

  test("wildcard does not match bare domain", () => {
    expect(matchesAllowlist("example.com", ["*.example.com"])).toBe(false);
  });

  test("wildcard does not match unrelated domain", () => {
    expect(matchesAllowlist("notexample.com", ["*.example.com"])).toBe(false);
  });

  test("empty allowlist matches nothing", () => {
    expect(matchesAllowlist("anything.com", [])).toBe(false);
  });

  test("multiple entries", () => {
    const list = ["api.anthropic.com", "github.com", "*.npmjs.org"];
    expect(matchesAllowlist("api.anthropic.com", list)).toBe(true);
    expect(matchesAllowlist("github.com", list)).toBe(true);
    expect(matchesAllowlist("registry.npmjs.org", list)).toBe(true);
    expect(matchesAllowlist("evil.com", list)).toBe(false);
  });
});

describe("isPrivateIP", () => {
  test("loopback IPv4", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("127.255.255.255")).toBe(true);
  });

  test("10.x.x.x range", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("10.255.255.255")).toBe(true);
  });

  test("172.16-31.x.x range", () => {
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
    expect(isPrivateIP("172.15.0.1")).toBe(false);
    expect(isPrivateIP("172.32.0.1")).toBe(false);
  });

  test("192.168.x.x range", () => {
    expect(isPrivateIP("192.168.0.1")).toBe(true);
    expect(isPrivateIP("192.168.255.255")).toBe(true);
  });

  test("link-local 169.254.x.x", () => {
    expect(isPrivateIP("169.254.1.1")).toBe(true);
  });

  test("IPv6 loopback", () => {
    expect(isPrivateIP("::1")).toBe(true);
  });

  test("IPv6 link-local", () => {
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  test("public IPs are not private", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("93.184.216.34")).toBe(false);
  });

  test("0.0.0.0", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
  });
});

describe("proxy server", () => {
  const handles: ProxyHandle[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const h of handles) h.stop();
    handles.length = 0;
    for (const s of servers) s.close();
    servers.length = 0;
  });

  /** Start a dummy TCP server that echoes data back */
  function startEchoServer(): Promise<{ port: number }> {
    return new Promise((resolve) => {
      const server = createServer((socket) => {
        socket.on("data", (d) => socket.write(d));
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          resolve({ port: addr.port });
        }
      });
    });
  }

  async function launch(allowlist: string[], rejectPrivateIPs = true): Promise<ProxyHandle> {
    const h = await startProxy({ allowlist, rejectPrivateIPs });
    handles.push(h);
    return h;
  }

  /** Send a raw request to the proxy and return the first response line's status code */
  function sendRequest(proxyPort: number, request: string): Promise<{ statusCode: number; response: string }> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      Bun.connect({
        hostname: "127.0.0.1",
        port: proxyPort,
        socket: {
          open(socket) {
            socket.write(request);
          },
          data(socket, data) {
            const response = Buffer.from(data).toString();
            const firstLine = response.split("\r\n")[0];
            const statusCode = parseInt(firstLine.split(" ")[1]);
            resolved = true;
            resolve({ statusCode, response });
            socket.end();
          },
          close() {
            if (!resolved) reject(new Error("closed before response"));
          },
          error(_, e) {
            if (!resolved) reject(e);
          },
        },
      });
    });
  }

  test("starts and returns a port", async () => {
    const h = await launch(["example.com"]);
    expect(h.port).toBeGreaterThan(0);
  });

  test("allows CONNECT to allowlisted host (localhost echo server)", async () => {
    const echo = await startEchoServer();
    const h = await launch(["127.0.0.1"], false);

    const { statusCode } = await sendRequest(
      h.port,
      `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`,
    );
    expect(statusCode).toBe(200);
  });

  test("rejects CONNECT to non-allowlisted host", async () => {
    const h = await launch(["example.com"]);
    const { statusCode } = await sendRequest(
      h.port,
      "CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n",
    );
    expect(statusCode).toBe(403);
  });

  test("rejects plain HTTP GET", async () => {
    const h = await launch(["example.com"]);
    const { statusCode } = await sendRequest(
      h.port,
      "GET http://evil.com/ HTTP/1.1\r\nHost: evil.com\r\n\r\n",
    );
    expect(statusCode).toBe(403);
  });

  test("relays data through CONNECT tunnel", async () => {
    const echo = await startEchoServer();
    const h = await launch(["127.0.0.1"], false);

    const relayed = await new Promise<string>((resolve, reject) => {
      let gotHandshake = false;
      let resolved = false;

      Bun.connect({
        hostname: "127.0.0.1",
        port: h.port,
        socket: {
          open(socket) {
            socket.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
          },
          data(socket, data) {
            const text = Buffer.from(data).toString();
            if (!gotHandshake) {
              expect(text).toStartWith("HTTP/1.1 200");
              gotHandshake = true;
              socket.write("hello from client");
              return;
            }
            resolved = true;
            resolve(text);
            socket.end();
          },
          close() {
            if (!resolved) reject(new Error("closed before relay"));
          },
          error(_, e) {
            if (!resolved) reject(e);
          },
        },
      });
    });

    expect(relayed).toBe("hello from client");
  });

  test("rejects CONNECT when hostname resolves to private IP", async () => {
    // "localhost" resolves to 127.0.0.1 — should be rejected even if allowlisted
    const h = await launch(["localhost"]);
    const { statusCode } = await sendRequest(
      h.port,
      "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n",
    );
    expect(statusCode).toBe(403);
  });

  test("allows CONNECT to private IP when rejectPrivateIPs is false", async () => {
    const echo = await startEchoServer();
    const h = await launch(["127.0.0.1"], false);

    const { statusCode } = await sendRequest(
      h.port,
      `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`,
    );
    expect(statusCode).toBe(200);
  });

  test("stop() shuts down the server", async () => {
    const h = await launch(["example.com"]);
    const port = h.port;
    h.stop();
    handles.length = 0;

    try {
      await fetch(`http://127.0.0.1:${port}/`);
      expect(true).toBe(false);
    } catch {
      // Expected — server is stopped
    }
  });
});

describe("startApiProxy", () => {
  const apiHandles: ProxyHandle[] = [];
  const upstreamServers: Server[] = [];

  afterEach(async () => {
    for (const h of apiHandles) h.stop();
    apiHandles.length = 0;
    for (const s of upstreamServers) s.close();
    upstreamServers.length = 0;
  });

  /**
   * Send an HTTP/1.1 request directly via TCP (bypasses HTTP_PROXY env var).
   * Returns status code and response body.
   */
  function sendHttpRequest(
    port: number,
    method: string,
    path: string,
    body?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const bodyBytes = body ? Buffer.from(body) : Buffer.alloc(0);
      const headerLines = [
        `${method} ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Content-Length: ${bodyBytes.length}`,
        "Connection: close",
        ...Object.entries(extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ].join("\r\n");

      const req = headerLines + (body ?? "");

      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(socket) {
            socket.write(req);
          },
          data(socket, data) {
            const text = Buffer.from(data).toString();
            const sepIdx = text.indexOf("\r\n\r\n");
            const headerSection = sepIdx >= 0 ? text.slice(0, sepIdx) : text;
            const firstLine = headerSection.split("\r\n")[0];
            const status = parseInt(firstLine.split(" ")[1] ?? "0");
            const respBody = sepIdx >= 0 ? text.slice(sepIdx + 4) : "";
            resolved = true;
            resolve({ status, body: respBody });
            socket.end();
          },
          close() {
            if (!resolved) reject(new Error("closed before response"));
          },
          error(_, e) {
            if (!resolved) reject(e);
          },
        },
      });
    });
  }

  /**
   * Start a plain TCP server that records the raw request and returns a canned HTTP response.
   * Used to inspect what headers the API proxy forwards upstream.
   */
  function startRecordingUpstream(
    responseBody: string = "{}",
    status: number = 200,
  ): Promise<{ port: number; lastRequest: () => string }> {
    let lastRequest = "";

    const server = createServer((socket) => {
      socket.on("data", (data) => {
        lastRequest += data.toString();
        // Once we have the full headers, send response
        if (lastRequest.includes("\r\n\r\n")) {
          socket.write(
            `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\nContent-Length: ${responseBody.length}\r\nConnection: close\r\n\r\n${responseBody}`,
          );
          socket.end();
        }
      });
    });
    upstreamServers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ port, lastRequest: () => lastRequest });
      });
    });
  }

  test("starts and returns a positive port", async () => {
    const h = await startApiProxy({
      credentials: { apiKey: "sk-ant-test" },
    });
    apiHandles.push(h);
    expect(h.port).toBeGreaterThan(0);
  });

  test("injects x-api-key when apiKey credential provided", async () => {
    const upstream = await startRecordingUpstream();
    const h = await startApiProxy({
      credentials: { apiKey: "sk-ant-real-key" },
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    apiHandles.push(h);

    await sendHttpRequest(h.port, "POST", "/v1/messages", "{}");
    expect(upstream.lastRequest()).toContain("x-api-key: sk-ant-real-key");
  });

  test("injects Authorization Bearer when oauthToken credential provided", async () => {
    const upstream = await startRecordingUpstream();
    const h = await startApiProxy({
      credentials: { oauthToken: "oauth-token-xyz" },
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    apiHandles.push(h);

    await sendHttpRequest(h.port, "POST", "/v1/messages", "{}");
    expect(upstream.lastRequest()).toContain("authorization: Bearer oauth-token-xyz");
  });

  test("strips dummy x-api-key sent by sandbox and injects real key", async () => {
    const upstream = await startRecordingUpstream();
    const h = await startApiProxy({
      credentials: { apiKey: "sk-ant-real-key" },
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    apiHandles.push(h);

    // Sandbox sends its dummy key — proxy must replace with the real one
    await sendHttpRequest(h.port, "POST", "/v1/messages", "{}", { "x-api-key": "deer-proxy-key" });
    expect(upstream.lastRequest()).toContain("x-api-key: sk-ant-real-key");
    expect(upstream.lastRequest()).not.toContain("deer-proxy-key");
  });

  test("forwards request body to upstream", async () => {
    const upstream = await startRecordingUpstream();
    const h = await startApiProxy({
      credentials: { apiKey: "sk-ant-test" },
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    apiHandles.push(h);

    await sendHttpRequest(h.port, "POST", "/v1/messages", '{"model":"claude-sonnet-4-6"}', {
      "content-type": "application/json",
    });
    expect(upstream.lastRequest()).toContain('{"model":"claude-sonnet-4-6"}');
  });

  test("returns upstream response status and body", async () => {
    const upstream = await startRecordingUpstream('{"error":"not_found"}', 404);
    const h = await startApiProxy({
      credentials: { apiKey: "sk-ant-test" },
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    apiHandles.push(h);

    const res = await sendHttpRequest(h.port, "POST", "/v1/messages", "{}");
    expect(res.status).toBe(404);
    expect(res.body).toContain('{"error":"not_found"}');
  });

  test("stop() shuts down the API proxy", async () => {
    const h = await startApiProxy({ credentials: { apiKey: "sk-ant-test" } });
    const port = h.port;
    h.stop();

    // fetch() goes through HTTP_PROXY which in turn tries to CONNECT to our stopped
    // server — the connection is refused, so fetch throws.
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      expect(true).toBe(false);
    } catch {
      // Expected — server is stopped
    }
  });
});
