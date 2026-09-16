import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { discoverAgents, type AgentDiscovery, type AgentId } from "./discovery.ts";

export interface WorkbenchOptions {
  workspaceRoot: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  openBrowser?: boolean;
  serveWebApp?: boolean;
  agentCommands?: Partial<Record<AgentId, string>>;
}

export interface RunningWorkbench {
  origin: string;
  browserUrl: string;
  token: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

function validToken(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

function cookieToken(request: IncomingMessage): string | undefined {
  const prefix = "skillbenchmark_session=";
  return request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

export async function startLocalWorkbench(options: WorkbenchOptions): Promise<RunningWorkbench> {
  const host = options.host ?? "127.0.0.1";
  const token = randomBytes(32).toString("base64url");
  let origin = "";
  let agents: AgentDiscovery[] = await discoverAgents({ workspaceRoot: options.workspaceRoot, commands: options.agentCommands });
  let lastRefreshAt = 0;
  let refresh: Promise<AgentDiscovery[]> | null = null;
  let vite: ViteDevServer | null = null;
  if (options.serveWebApp !== false) {
    vite = await createViteServer({
      root: resolve(import.meta.dirname, "../../web"),
      appType: "spa",
      server: { middlewareMode: true, hmr: false },
      clearScreen: false,
    });
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      response.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-frame-options", "DENY");
      const requestUrl = new URL(request.url ?? "/", origin);
      const expectedHost = new URL(origin).host;
      if (request.headers.host !== expectedHost) return sendJson(response, 400, { error: "invalid host" });
      if (request.method === "GET" && requestUrl.pathname === "/" && validToken(requestUrl.searchParams.get("token") ?? undefined, token)) {
        response.writeHead(303, { location: "/", "set-cookie": `skillbenchmark_session=${token}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (requestUrl.pathname.startsWith("/api/")) {
        if (request.headers.origin && request.headers.origin !== origin) return sendJson(response, 403, { error: "invalid origin" });
        if (!validToken(request.headers["x-skillbenchmark-token"], token) && !validToken(cookieToken(request), token)) return sendJson(response, 401, { error: "invalid token" });
        if (request.method === "GET" && requestUrl.pathname === "/api/v1/workspace") {
          return sendJson(response, 200, { name: basename(options.workspaceRoot), root: options.workspaceRoot });
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/v1/agents") return sendJson(response, 200, { agents });
        if (request.method === "POST" && requestUrl.pathname === "/api/v1/agents/refresh") {
          const now = Date.now();
          if (!refresh && now - lastRefreshAt >= 1_000) {
            refresh = discoverAgents({ workspaceRoot: options.workspaceRoot, commands: options.agentCommands });
            try { agents = await refresh; lastRefreshAt = Date.now(); } finally { refresh = null; }
          } else if (refresh) agents = await refresh;
          return sendJson(response, 200, { agents });
        }
        return sendJson(response, 404, { error: "not found" });
      }
      if (!vite) return sendJson(response, 404, { error: "web app disabled" });
      vite.middlewares(request, response, (error?: unknown) => {
        if (error) sendJson(response, 500, { error: "web app failed" });
        else if (!response.writableEnded) sendJson(response, 404, { error: "not found" });
      });
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      else response.destroy();
    });
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4317, host, () => resolveListen());
    });
  } catch (error) {
    await vite?.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  origin = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
  const browserUrl = `${origin}/?token=${encodeURIComponent(token)}`;
  if (options.openBrowser !== false) openBrowser(browserUrl);
  return {
    origin,
    browserUrl,
    token,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => server.close((error?: Error) => error ? reject(error) : resolveClose()));
      await vite?.close();
    },
  };
}
