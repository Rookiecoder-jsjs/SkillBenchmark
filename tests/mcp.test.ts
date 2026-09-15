import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { handleRequest } from "../apps/mcp-server/src/index.ts";

function nextResponse(child: ChildProcess, timeoutMs = 1000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error(`MCP response timed out after ${timeoutMs}ms`)); }, timeoutMs);
    const cleanup = (): void => { clearTimeout(timer); child.stdout?.off("data", onData); child.off("error", onError); };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      cleanup();
      try { resolve(JSON.parse(line) as Record<string, unknown>); } catch (error) { reject(error); }
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    child.stdout?.setEncoding("utf8").on("data", onData);
    child.on("error", onError);
  });
}

test("MCP bridge exposes plan and run workflows", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-mcp-"));
  const planDir = join(root, "plan");
  const runDir = join(root, "run");
  const listed = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal((listed.result as { tools: unknown[] }).tools.length, 8);
  const plan = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "skillbenchmark_plan", arguments: { suite_path: "suites/smoke/suite.json", output_dir: planDir } } });
  assert.match(JSON.stringify(plan), /trial_count/);
  const run = await handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "skillbenchmark_run", arguments: { suite_path: "suites/smoke/suite.json", output_dir: runDir } } });
  assert.match(JSON.stringify(run), /gate/);
  const report = await handleRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "skillbenchmark_report", arguments: { report_path: join(runDir, "report.json") } } });
  assert.match(JSON.stringify(report), /summary/);
  const compared = await handleRequest({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "skillbenchmark_compare", arguments: { report_path: join(runDir, "report.json") } } });
  assert.match(JSON.stringify(compared), /comparisons/);
  const skillDir = join(root, "skill");
  await mkdir(skillDir);
  await writeFile(join(skillDir, "SKILL.md"), "# MCP Skill\n");
  const evolved = await handleRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "skillbenchmark_evolve", arguments: { suite_path: "suites/smoke/suite.json", skill_dir: skillDir, output_dir: join(root, "evolution") } } });
  assert.match(JSON.stringify(evolved), /proposal_id/);
});

test("MCP stdio responds before stdin closes and rejects oversized requests", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["apps/mcp-server/src/index.ts"], { cwd: process.cwd(), env: { ...process.env, SKILLBENCHMARK_MCP_MAX_REQUEST_BYTES: "128" }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    const initialized = await nextResponse(child);
    assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, "skillbenchmark");
    child.stdin.write("x".repeat(200));
    child.stdin.write("\n");
    const oversized = await nextResponse(child);
    assert.equal((oversized.error as { code: number }).code, -32600);
  } finally {
    child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
    await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
});
