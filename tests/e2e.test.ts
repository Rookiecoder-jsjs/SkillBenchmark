import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["apps/cli/src/index.ts", ...args], { cwd: process.cwd() });
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
