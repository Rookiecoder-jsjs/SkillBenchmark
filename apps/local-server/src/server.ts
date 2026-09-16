import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { discoverAgents, type AgentDiscovery, type AgentId } from "./discovery.ts";
import { WorkspaceSkillStore } from "./skill-store.ts";
import { publicSuiteVersion, WorkspaceSuiteStore } from "./suite-store.ts";
import { WorkspacePlanStore, type ExperimentType } from "./plan-store.ts";
import { WorkspaceRunStore } from "./run-store.ts";

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

async function readJsonBody(request: IncomingMessage, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new Error("content-type must be application/json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes <= maxBytes) chunks.push(value);
    else oversized = true;
  }
  if (oversized) throw new Error(`request body exceeds ${maxBytes} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("request body must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function importInput(body: Record<string, unknown>): { sourcePath: string; skillId?: string; name?: string } {
  if (typeof body.sourcePath !== "string" || !body.sourcePath.trim() || body.sourcePath.length > 4096) throw new Error("sourcePath must be a non-empty path");
  if (body.skillId !== undefined && (typeof body.skillId !== "string" || !/^skill-[0-9a-f-]{36}$/.test(body.skillId))) throw new Error("skillId is invalid");
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120)) throw new Error("name must contain 1 to 120 characters");
  return { sourcePath: body.sourcePath.trim(), skillId: body.skillId as string | undefined, name: typeof body.name === "string" ? body.name.trim() : undefined };
}

function suiteImportInput(body: Record<string, unknown>): string {
  if (typeof body.sourcePath !== "string" || !body.sourcePath.trim() || body.sourcePath.length > 4096) throw new Error("sourcePath must be a non-empty path");
  return body.sourcePath.trim();
}

function planInput(body: Record<string, unknown>): { name: string; experimentType: ExperimentType; suiteVersionId: string; incumbentVersionId?: string; candidateVersionId: string; agentId: AgentId; model?: string; repeats: number; timeoutMs: number; concurrency: number } {
  if (typeof body.name !== "string") throw new Error("name is required");
  if (body.experimentType !== "trial" && body.experimentType !== "effectiveness" && body.experimentType !== "version-comparison") throw new Error("experimentType must be trial, effectiveness or version-comparison");
  if (typeof body.suiteVersionId !== "string" || !/^suite-version-[0-9a-f-]{36}$/.test(body.suiteVersionId)) throw new Error("suiteVersionId is invalid");
  if (typeof body.candidateVersionId !== "string" || !/^version-[0-9a-f-]{36}$/.test(body.candidateVersionId)) throw new Error("candidateVersionId is invalid");
  if (body.experimentType === "version-comparison" && (typeof body.incumbentVersionId !== "string" || !/^version-[0-9a-f-]{36}$/.test(body.incumbentVersionId))) throw new Error("incumbentVersionId is required for version comparison");
  if (body.experimentType !== "version-comparison" && body.incumbentVersionId !== undefined) throw new Error("incumbentVersionId is only valid for version comparison");
  if (body.agentId !== "codex" && body.agentId !== "claude-code") throw new Error("agentId is invalid");
  if (body.model !== undefined && typeof body.model !== "string") throw new Error("model must be a string");
  if (typeof body.repeats !== "number" || typeof body.timeoutMs !== "number" || typeof body.concurrency !== "number") throw new Error("repeats, timeoutMs and concurrency must be numbers");
  return { name: body.name, experimentType: body.experimentType, suiteVersionId: body.suiteVersionId, incumbentVersionId: body.incumbentVersionId as string | undefined, candidateVersionId: body.candidateVersionId, agentId: body.agentId, model: body.model as string | undefined, repeats: body.repeats, timeoutMs: body.timeoutMs, concurrency: body.concurrency };
}

export async function startLocalWorkbench(options: WorkbenchOptions): Promise<RunningWorkbench> {
  const host = options.host ?? "127.0.0.1";
  const token = randomBytes(32).toString("base64url");
  let origin = "";
  let agents: AgentDiscovery[] = await discoverAgents({ workspaceRoot: options.workspaceRoot, commands: options.agentCommands });
  let lastRefreshAt = 0;
  let refresh: Promise<AgentDiscovery[]> | null = null;
  let vite: ViteDevServer | null = null;
  let skillStore: WorkspaceSkillStore | null = null;
  let suiteStore: WorkspaceSuiteStore | null = null;
  let planStore: WorkspacePlanStore | null = null;
  let runStore: WorkspaceRunStore | null = null;
  try {
    if (options.serveWebApp !== false) {
      vite = await createViteServer({
        root: resolve(import.meta.dirname, "../../web"),
        appType: "spa",
        server: { middlewareMode: true, hmr: false },
        clearScreen: false,
      });
    }
    skillStore = new WorkspaceSkillStore(options.workspaceRoot);
    suiteStore = new WorkspaceSuiteStore(options.workspaceRoot);
    planStore = new WorkspacePlanStore(options.workspaceRoot);
    runStore = new WorkspaceRunStore(options.workspaceRoot, { planStore, suiteStore, skillStore });
  } catch (error) {
    await runStore?.close();
    planStore?.close();
    suiteStore?.close();
    skillStore?.close();
    await vite?.close();
    throw error;
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
        if (request.method === "GET" && requestUrl.pathname === "/api/v1/skills") return sendJson(response, 200, { skills: skillStore?.listSkills() ?? [] });
        if (request.method === "POST" && requestUrl.pathname === "/api/v1/skills/import") {
          try {
            const result = await skillStore!.importFromDirectory(importInput(await readJsonBody(request)));
            return sendJson(response, result.created ? 201 : 200, result);
          } catch (error) {
            return sendJson(response, 400, { error: error instanceof Error ? error.message : "Skill import failed" });
          }
        }
        const diffMatch = requestUrl.pathname.match(/^\/api\/v1\/skills\/(skill-[0-9a-f-]{36})\/diff$/);
        if (request.method === "GET" && diffMatch) {
          const from = requestUrl.searchParams.get("from");
          const to = requestUrl.searchParams.get("to");
          if (!from || !to) return sendJson(response, 400, { error: "from and to version ids are required" });
          try { return sendJson(response, 200, await skillStore!.diffVersions(diffMatch[1], from, to)); }
          catch { return sendJson(response, 404, { error: "Skill or version not found" }); }
        }
        const skillMatch = requestUrl.pathname.match(/^\/api\/v1\/skills\/(skill-[0-9a-f-]{36})$/);
        if (request.method === "GET" && skillMatch) {
          try { return sendJson(response, 200, skillStore!.getSkill(skillMatch[1])); }
          catch { return sendJson(response, 404, { error: "Skill not found" }); }
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/v1/suites") return sendJson(response, 200, { suites: suiteStore?.listSuites() ?? [] });
        if (request.method === "POST" && requestUrl.pathname === "/api/v1/suites/import") {
          try {
            const result = await suiteStore!.importFromFile(suiteImportInput(await readJsonBody(request)));
            return sendJson(response, result.created ? 201 : 200, { ...result, version: publicSuiteVersion(result.version) });
          } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Suite import failed" }); }
        }
        const suiteMatch = requestUrl.pathname.match(/^\/api\/v1\/suites\/([A-Za-z0-9._-]+)$/);
        if (request.method === "GET" && suiteMatch) {
          try { return sendJson(response, 200, suiteStore!.getSuite(suiteMatch[1])); }
          catch { return sendJson(response, 404, { error: "Suite not found" }); }
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/v1/plans") return sendJson(response, 200, { plans: planStore?.listPlans() ?? [] });
        if (request.method === "POST" && requestUrl.pathname === "/api/v1/plans") {
          try {
            const input = planInput(await readJsonBody(request));
            const agent = agents.find((item) => item.id === input.agentId);
            if (!agent) throw new Error("Selected Agent was not discovered");
            const plan = planStore!.createPlan({ name: input.name, experimentType: input.experimentType, suiteVersion: suiteStore!.getVersion(input.suiteVersionId), incumbentVersion: input.incumbentVersionId ? skillStore!.getVersion(input.incumbentVersionId) : undefined, candidateVersion: skillStore!.getVersion(input.candidateVersionId), agent, model: input.model, repeats: input.repeats, timeoutMs: input.timeoutMs, concurrency: input.concurrency });
            return sendJson(response, 201, plan);
          } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Plan creation failed" }); }
        }
        const planRunMatch = requestUrl.pathname.match(/^\/api\/v1\/plans\/(plan-[0-9a-f-]{36})\/runs$/);
        if (request.method === "POST" && planRunMatch) {
          try { return sendJson(response, 202, runStore!.start(planRunMatch[1])); }
          catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Run start failed" }); }
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/v1/runs") return sendJson(response, 200, { runs: runStore?.listRuns() ?? [] });
        const runCancelMatch = requestUrl.pathname.match(/^\/api\/v1\/runs\/(run-[0-9a-f-]{36})\/cancel$/);
        if (request.method === "POST" && runCancelMatch) {
          try { return sendJson(response, 202, runStore!.cancel(runCancelMatch[1])); }
          catch { return sendJson(response, 404, { error: "Run not found" }); }
        }
        const runMatch = requestUrl.pathname.match(/^\/api\/v1\/runs\/(run-[0-9a-f-]{36})$/);
        if (request.method === "GET" && runMatch) {
          try { return sendJson(response, 200, runStore!.getRun(runMatch[1])); }
          catch { return sendJson(response, 404, { error: "Run not found" }); }
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
    await runStore?.close();
    planStore?.close();
    suiteStore?.close();
    skillStore?.close();
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
      try { await new Promise<void>((resolveClose, reject) => server.close((error?: Error) => error ? reject(error) : resolveClose())); }
      finally { await runStore?.close(); planStore?.close(); suiteStore?.close(); skillStore?.close(); await vite?.close(); }
    },
  };
}
