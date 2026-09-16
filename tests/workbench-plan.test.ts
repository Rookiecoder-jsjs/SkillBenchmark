import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSkillStore } from "../apps/local-server/src/skill-store.ts";
import { WorkspaceSuiteStore } from "../apps/local-server/src/suite-store.ts";
import { WorkspacePlanStore } from "../apps/local-server/src/plan-store.ts";

test("workspace Suite store freezes versions and rejects invalid task splits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-suite-store-"));
  const workspace = join(root, "workspace");
  const source = join(root, "suite.json");
  await mkdir(workspace);
  const suite = { suite_id: "review-suite", label: "Review Suite", tasks: [{ task_id: "task-1", family_id: "review", source_group: "source-1", split: "validation", prompt: "Review this", expected_output: "ok", mock_outputs: {}, tags: [] }] };
  await writeFile(source, JSON.stringify(suite));
  const store = new WorkspaceSuiteStore(workspace);
  t.after(() => store.close());
  const first = await store.importFromFile(source);
  assert.equal(first.created, true);
  assert.equal(first.version.ordinal, 1);
  const duplicate = await store.importFromFile(source);
  assert.equal(duplicate.created, false);
  suite.tasks.push({ task_id: "task-2", family_id: "review", source_group: "source-2", split: "validation", prompt: "Fix this", expected_output: "fixed", mock_outputs: {}, tags: [] });
  await writeFile(source, JSON.stringify(suite));
  const second = await store.importFromFile(source);
  assert.equal(second.version.ordinal, 2);
  assert.equal(second.version.parentVersionId, first.version.versionId);
  assert.equal(store.getSuite("review-suite").versions.length, 2);

  suite.tasks[1].source_group = "source-1";
  suite.tasks[1].split = "test";
  await writeFile(source, JSON.stringify(suite));
  await assert.rejects(store.importFromFile(source), /split_overlap/);
});

test("workbench plan freezes Suite, Agent, budget and exact Skill version bindings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-plan-store-"));
  const workspace = join(root, "workspace");
  const skillSource = join(root, "skill");
  const suiteSource = join(root, "suite.json");
  await mkdir(workspace);
  await mkdir(skillSource);
  await writeFile(join(skillSource, "SKILL.md"), "# Planner Skill\n");
  await writeFile(suiteSource, JSON.stringify({ suite_id: "planner-suite", tasks: [{ task_id: "one", family_id: "plan", source_group: "one", split: "validation", prompt: "Do it", expected_output: "done", mock_outputs: {}, tags: [] }] }));
  const skills = new WorkspaceSkillStore(workspace);
  const suites = new WorkspaceSuiteStore(workspace);
  const plans = new WorkspacePlanStore(workspace);
  t.after(() => { plans.close(); suites.close(); skills.close(); });
  const skill = await skills.importFromDirectory({ sourcePath: skillSource });
  const suite = await suites.importFromFile(suiteSource);
  const plan = plans.createPlan({
    name: "Effectiveness check",
    experimentType: "effectiveness",
    suiteVersion: suite.version,
    candidateVersion: skill.version,
    agent: { id: "codex", name: "Codex", installation: "found", authentication: "unknown", evaluationSupport: "exploratory", executablePath: "/usr/bin/codex", version: "1.2.3", capabilities: ["structured-output"], detectedAt: new Date().toISOString(), evidence: [] },
    repeats: 2,
    timeoutMs: 30_000,
    concurrency: 1,
  });
  assert.deepEqual(plan.corePlan.conditions, ["none", "candidate"]);
  assert.equal(plan.corePlan.trials.length, 4);
  assert.equal(plan.bindings.none, null);
  assert.equal(plan.bindings.candidate?.versionId, skill.version.versionId);
  assert.equal(plan.bindings.candidate?.treeDigest, skill.version.treeDigest);
  assert.equal(plan.suite.versionId, suite.version.versionId);
  assert.ok(plan.planDigest.length === 64);
  assert.equal(plans.listPlans()[0].planId, plan.planId);
});
