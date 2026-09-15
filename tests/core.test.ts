import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunPlan } from "../packages/core/src/plan.ts";
import { executePlan } from "../packages/core/src/pipeline.ts";
import { importSkillSnapshot } from "../packages/core/src/snapshot.ts";
import { loadSuite } from "../packages/core/src/suite.ts";

test("P0 smoke pipeline grades a known regression", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  const plan = createRunPlan(suite, { repeats: 1 });
  const report = executePlan(suite, plan);
  assert.equal(report.results.length, 9);
  assert.equal(report.summary.by_condition.candidate.passed, 2);
  assert.equal(report.summary.by_condition.candidate.success_rate, 2 / 3);
  assert.equal(report.summary.contrasts[1].effect, -1 / 3);
});

test("plan enforces max_trials before execution", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  assert.throws(() => createRunPlan(suite, { repeats: 1, budget: { max_trials: 8 } }), /over max_trials/);
});

test("skill snapshot changes when a file changes and rejects external symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillbenchmark-skill-"));
  await writeFile(join(dir, "SKILL.md"), "v1\n");
  const first = await importSkillSnapshot(dir, "test");
  await writeFile(join(dir, "SKILL.md"), "v2\n");
  const second = await importSkillSnapshot(dir, "test");
  assert.notEqual(first.tree_digest, second.tree_digest);
  const outside = await mkdtemp(join(tmpdir(), "skillbenchmark-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(join(outside, "secret.txt"), join(dir, "secret.txt"));
  await assert.rejects(importSkillSnapshot(dir), /external symlink/);
});
