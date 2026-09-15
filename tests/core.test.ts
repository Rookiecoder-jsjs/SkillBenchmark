import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunPlan } from "../packages/core/src/plan.ts";
import { executePlan } from "../packages/core/src/pipeline.ts";
import { importSkillSnapshot } from "../packages/core/src/snapshot.ts";
import { loadSuite } from "../packages/core/src/suite.ts";
import { SqliteStore } from "../packages/core/src/storage.ts";
import { runExternalGrader } from "../packages/core/src/external-grader.ts";

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

test("suite rejects source groups that overlap splits", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  const overlapping = { ...suite.tasks[0], task_id: "overlap", source_group: "shared", split: "train" as const };
  const second = { ...suite.tasks[1], task_id: "overlap-2", source_group: "shared", split: "validation" as const };
  const path = join(await mkdtemp(join(tmpdir(), "skillbenchmark-suite-")), "suite.json");
  await writeFile(path, JSON.stringify({ suite_id: "bad", tasks: [overlapping, second] }));
  await assert.rejects(loadSuite(path), /split_overlap/);
});

test("SQLite store persists results and resumes without duplicate events", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  const plan = createRunPlan(suite, { repeats: 1, runId: "run-store-test" });
  const dir = await mkdtemp(join(tmpdir(), "skillbenchmark-db-"));
  const store = new SqliteStore(join(dir, "metadata.sqlite"));
  const first = executePlan(suite, plan, store);
  assert.equal(first.results.length, 9);
  assert.equal(store.countEvents(first.results[0].spec.trial_id), 5);
  const second = executePlan(suite, plan, store);
  assert.deepEqual(second.results, first.results);
  assert.equal(store.countEvents(first.results[0].spec.trial_id), 5);
  store.close();
});

test("external grader accepts structured Grade output", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  const task = suite.tasks[0];
  const grade = await runExternalGrader({ command: process.execPath, args: ["tests/fixtures/external-grader.mjs"] }, {
    schema_version: "0.1",
    trial_id: "external-trial",
    task: { task_id: task.task_id, public_input: task.prompt, expected_output: task.expected_output },
    artifact: { output: task.expected_output, output_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  });
  assert.equal(grade.outcome, "pass");
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
