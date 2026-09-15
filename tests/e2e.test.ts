import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["apps/cli/src/index.ts", ...args], { cwd: process.cwd(), env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("end-to-end CLI run creates plan, SQLite index, JSON, Markdown and HTML report", async () => {
  const output = await mkdtemp(join(tmpdir(), "skillbenchmark-e2e-"));
  const result = await runCli(["run", "suites/smoke/suite.json", output]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /candidate: 2\/3 passed/);
  const report = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
  assert.equal(report.summary.by_condition.candidate.passed, 2);
  assert.equal(report.summary.contrasts[1].effect, -1 / 3);
  assert.match(await readFile(join(output, "report.md"), "utf8"), /candidate/);
  assert.match(await readFile(join(output, "report.html"), "utf8"), /<!doctype html>/i);
  const plan = JSON.parse(await readFile(join(output, "plan.json"), "utf8"));
  assert.equal(plan.trials.length, 9);
  assert.equal((await readFile(join(output, "metadata.sqlite"))).byteLength > 0, true);
});

test("end-to-end Codex adapter command uses structured output and isolated Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-adapter-e2e-"));
  const skill = join(root, "skill");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "# Adapter Skill\n");
  const output = join(root, "run");
  const result = await runCli(["run-adapter", "codex", "suites/smoke/suite.json", skill, output], { SKILLBENCHMARK_CODEX_COMMAND: join(process.cwd(), "tests/fixtures/fake-codex.mjs") });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
  assert.equal(report.plan.profiles[0].platform, "codex");
  assert.equal(report.results.length, 9);
  assert.equal(report.summary.by_condition.candidate.passed, 3);
});

test("end-to-end evolve and release workflows preserve lineage and export receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-release-e2e-"));
  const skill = join(root, "skill");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "# Smoke Skill\n");
  const evolution = join(root, "evolution");
  const evolved = await runCli(["evolve", "suites/smoke/suite.json", skill, evolution]);
  assert.equal(evolved.code, 0, evolved.stderr);
  assert.match(evolved.stdout, /proposal=/);
  const gatePath = join(root, "accepted-gate.json");
  await writeFile(gatePath, JSON.stringify({ decision_id: "e2e-gate", comparison_refs: [], policy: {}, status: "accept", reasons: ["e2e"] }));
  const registry = join(root, "registry");
  const first = await runCli(["release", "publish", skill, gatePath, registry]);
  assert.equal(first.code, 0, first.stderr);
  const firstRelease = JSON.parse(first.stdout).release_id;
  const candidate = join(evolution, "candidate");
  const second = await runCli(["release", "publish", candidate, gatePath, registry]);
  assert.equal(second.code, 0, second.stderr);
  const secondRelease = JSON.parse(second.stdout).release_id;
  const exportDir = join(root, "export");
  const exported = await runCli(["release", "export", registry, secondRelease, "claude-code", exportDir]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(await readFile(join(exportDir, "export-receipt.json"))).platform, "claude-code");
  const rolledBack = await runCli(["release", "rollback", registry, firstRelease]);
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.match(rolledBack.stdout, /rolled back to/);
});
