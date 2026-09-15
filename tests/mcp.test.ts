import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../apps/mcp-server/src/index.ts";

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
