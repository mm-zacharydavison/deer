import { connect as netConnect, type Socket as NetSocket } from "node:net";
import { resolve as dnsResolve } from "node:dns/promises";

export interface ProxyOptions {
  allowlist: string[];
  /**
   * Reject connections to RFC1918/loopback addresses after DNS resolution.
   * Prevents DNS rebinding attacks where an allowlisted hostname resolves
   * to an internal IP.
   * @default true
   */
  rejectPrivateIPs?: boolean;
}

export interface ProxyHandle {
  port: number;
  stop: () => void;
}

/**
 * Check if a hostname matches an allowlist entry.
 * Supports exact matches and wildcard subdomain patterns (e.g. "*.example.com").
 */
export function matchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const lower = hostname.toLowerCase();
  for (const entry of allowlist) {
    const pattern = entry.toLowerCase();
    if (pattern === lower) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (lower.endsWith(suffix) && lower.length > suffix.length) return true;
    }
  }
  return false;
}

/**
 * Check if an IP address is in a private/reserved range (RFC1918, loopback, link-local).
 */
export function isPrivateIP(ip: string): boolean {
  // IPv6
  if (ip === "::1") return true;
  if (ip.toLowerCase().startsWith("fe80:")) return true;

  // IPv4
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);

  if (a === 0) return true;       // 0.0.0.0/8
  if (a === 10) return true;      // 10.0.0.0/8
  if (a === 127) return true;     // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16

  return false;
}

// ── Direct HTTP request (proxy-bypassing) ─────────────────────────────

/**
 * Make a direct HTTP or HTTPS request via Bun.connect, bypassing any
 * HTTP_PROXY/HTTPS_PROXY environment variables that Bun's fetch() and
 * node:http both respect unconditionally.
 */
async function directRequest(
  url: string,
  method: string,
  headers: Headers,
  body?: Buffer,
): Promise<Response> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const port = parseInt(parsed.port) || (isHttps ? 443 : 80);

  // Build HTTP/1.1 request bytes
  const headerLines: string[] = [
    `${method} ${parsed.pathname}${parsed.search} HTTP/1.1`,
    `Host: ${parsed.host}`,
  ];
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "host") headerLines.push(`${key}: ${value}`);
  });
  if (body) headerLines.push(`Content-Length: ${body.length}`);
  headerLines.push("Connection: close", "", "");

  const requestBytes = Buffer.concat([
    Buffer.from(headerLines.join("\r\n")),
    body ?? Buffer.alloc(0),
  ]);

  return new Promise<Response>((resolve, reject) => {
    let accumulated = Buffer.alloc(0);
    let resolved = false;

    function tryParse(end: boolean): void {
      const str = accumulated.toString("latin1");
      const headerEnd = str.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (end) reject(new Error("Connection closed before full HTTP response"));
        return;
      }

      const headerSection = str.slice(0, headerEnd);
      const lines = headerSection.split("\r\n");
      const status = parseInt(lines[0]?.split(" ")[1] ?? "0");

      const resHeaders = new Headers();
      for (const line of lines.slice(1)) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          resHeaders.set(line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim());
        }
      }

      const bodyBuf = accumulated.slice(headerEnd + 4);
      const contentLength = parseInt(resHeaders.get("content-length") ?? "-1");
      if (!end && contentLength >= 0 && bodyBuf.length < contentLength) return;

      resolved = true;
      resolve(new Response(bodyBuf, { status, headers: resHeaders }));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connectOpts: any = {
      hostname: parsed.hostname,
      port,
      socket: {
        open(socket: { write: (b: Buffer) => void }) {
          socket.write(requestBytes);
        },
        data(_socket: unknown, data: Uint8Array) {
          accumulated = Buffer.concat([accumulated, Buffer.from(data)]);
          if (!resolved) tryParse(false);
        },
        close() {
          if (!resolved) tryParse(true);
        },
        error(_socket: unknown, err: Error) {
          if (!resolved) reject(err);
        },
      },
    };
    if (isHttps) connectOpts.tls = {};

    Bun.connect(connectOpts);
  });
}

// ── API proxy ─────────────────────────────────────────────────────────

export interface HostCredentials {
  /** Anthropic API key for the x-api-key header */
  apiKey?: string;
  /** OAuth access token for the Authorization: Bearer header */
  oauthToken?: string;
}

export interface ApiProxyOptions {
  /** Credentials to inject into forwarded Anthropic API requests */
  credentials: HostCredentials;
  /**
   * Base URL of the upstream Anthropic API.
   * @default "https://api.anthropic.com"
   */
  upstreamBaseUrl?: string;
}

/**
 * Start an HTTP API proxy that injects host credentials into Anthropic API requests.
 *
 * Sandboxed Claude instances point ANTHROPIC_BASE_URL at this proxy. The proxy
 * strips any auth headers sent by the sandbox and replaces them with real
 * credentials read from the host. This ensures credentials never exist inside
 * the sandbox — only the proxy (running on the host) holds them.
 *
 * Returns a handle with the listening port and a stop function.
 */
export async function startApiProxy(options: ApiProxyOptions): Promise<ProxyHandle> {
  const { credentials, upstreamBaseUrl = "https://api.anthropic.com" } = options;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const upstreamUrl = `${upstreamBaseUrl}${url.pathname}${url.search}`;

      const headers = new Headers(req.headers);
      // Strip any auth the sandbox sends (it only has a dummy key)
      headers.delete("x-api-key");
      headers.delete("authorization");
      // Remove host so the upstream sets it correctly
      headers.delete("host");

      // Inject real host credentials
      if (credentials.apiKey) {
        headers.set("x-api-key", credentials.apiKey);
      } else if (credentials.oauthToken) {
        headers.set("authorization", `Bearer ${credentials.oauthToken}`);
      }

      const reqBody =
        req.method !== "GET" && req.method !== "HEAD"
          ? Buffer.from(await req.arrayBuffer())
          : undefined;

      // Forward directly to the upstream API using Bun.connect (raw TCP).
      // This bypasses HTTP_PROXY/HTTPS_PROXY env vars, which Bun's fetch()
      // and node:http always respect, even with agent:false.
      const response = await directRequest(upstreamUrl, req.method, headers, reqBody);

      return response;
    },
  });

  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}

// ── CONNECT proxy ─────────────────────────────────────────────────────

/** Per-connection upstream socket tracking */
const upstreams = new WeakMap<object, NetSocket>();

/**
 * Start a filtering HTTP CONNECT proxy.
 *
 * Only allows CONNECT tunnels to hosts in the allowlist.
 * All other requests (plain HTTP GET, non-allowlisted CONNECT) get 403.
 * Resolves DNS before connecting and rejects private IPs to prevent
 * DNS rebinding attacks.
 *
 * Returns a handle with the listening port and a stop function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const { allowlist, rejectPrivateIPs = true } = options;

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {},

      data(socket, rawData) {
        // If this connection already has an upstream, relay data to it
        const existing = upstreams.get(socket);
        if (existing) {
          existing.write(Buffer.from(rawData));
          return;
        }

        // First data on this connection — parse the HTTP request line
        const data = Buffer.from(rawData).toString();
        const firstLine = data.split("\r\n")[0];
        const parts = firstLine.split(" ");
        const method = parts[0];
        const target = parts[1] ?? "";

        if (method !== "CONNECT") {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.end();
          return;
        }

        // Parse host:port from CONNECT target
        const colonIdx = target.lastIndexOf(":");
        const host = colonIdx > 0 ? target.slice(0, colonIdx) : target;
        const port = colonIdx > 0 ? parseInt(target.slice(colonIdx + 1)) : 443;

        if (!matchesAllowlist(host, allowlist)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.end();
          return;
        }

        const connectToUpstream = (connectHost: string) => {
          const upstream = netConnect({ host: connectHost, port }, () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstreams.set(socket, upstream);
          });

          upstream.on("data", (chunk: Buffer) => {
            socket.write(chunk);
          });

          upstream.on("end", () => {
            socket.end();
          });

          upstream.on("error", () => {
            socket.end();
          });
        };

        if (rejectPrivateIPs) {
          dnsResolve(host).then((addresses) => {
            if (addresses.length === 0 || addresses.some(isPrivateIP)) {
              socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
              socket.end();
              return;
            }
            connectToUpstream(addresses[0]);
          }).catch(() => {
            socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            socket.end();
          });
        } else {
          connectToUpstream(host);
        }
      },

      drain() {},

      close(socket) {
        const upstream = upstreams.get(socket);
        if (upstream) {
          upstream.destroy();
          upstreams.delete(socket);
        }
      },

      error() {},
    },
  });

  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}
