import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDecision, RunReport } from "../packages/contracts/src/types.ts";
import { defaultGatePolicy } from "../packages/core/src/statistics.ts";
import { WorkspacePlanStore, type WorkbenchPlan } from "../apps/local-server/src/plan-store.ts";
import { WorkspaceReleaseStore } from "../apps/local-server/src/release-store.ts";
import { WorkspaceRunStore, type WorkbenchRun } from "../apps/local-server/src/run-store.ts";
import { WorkspaceSkillStore } from "../apps/local-server/src/skill-store.ts";
import { WorkspaceSuiteStore } from "../apps/local-server/src/suite-store.ts";

const acceptedGate: GateDecision = { decision_id: "decision-accepted", comparison_refs: ["incumbent-candidate"], policy: defaultGatePolicy, status: "accept", reasons: ["candidate passed release policy"] };

function persistRun(store: WorkspaceRunStore, plan: WorkbenchPlan, runId: string, gate: GateDecision): WorkbenchRun {
  const frozenPlan = {
    ...plan.corePlan,
    run_id: runId,
    trials: plan.corePlan.trials.map((trial) => ({ ...trial, run_id: runId, trial_id: trial.trial_id.replace(plan.corePlan.run_id, runId) })),
  };
  const comparison = (left: "none" | "incumbent", right: "incumbent" | "candidate", effect: number) => ({ schema_version: "0.1" as const, run_id: runId, left, right, strata: ["codex"], effect, interval: { lower: effect, upper: effect, level: 0.95 }, regressions: [], missingness: { missing_pairs: 0, total_pairs: 2 } });
  const comparisons = [comparison("none", "incumbent", 0.1), comparison("incumbent", "candidate", 0.5), comparison("none", "candidate", 0.6)];
  const report: RunReport = {
    schema_version: "0.1",
    run_id: runId,
    plan: frozenPlan,
    results: frozenPlan.trials.map((spec) => ({
      spec,
      receipt: { trial_id: spec.trial_id, status: "completed", started_at: "2026-09-17T00:00:01.000Z", finished_at: "2026-09-17T00:00:02.000Z", artifact: null, failure_reason: null },
      events: [],
      grade: { schema_version: "0.1", trial_id: spec.trial_id, grader_digest: "release-test-grader", outcome: "pass", metrics: { exact_match: 1 }, assertions: [], evidence_refs: [] },
    })),
    summary: { by_condition: {}, contrasts: [] },
    comparisons,
    gate,
  };
  const run: WorkbenchRun = { runId, planId: plan.planId, name: plan.name, status: "completed", createdAt: "2026-09-17T00:00:00.000Z", startedAt: "2026-09-17T00:00:01.000Z", finishedAt: "2026-09-17T00:00:02.000Z", trialCount: frozenPlan.trials.length, completedTrials: frozenPlan.trials.length, trialStatuses: Object.fromEntries(frozenPlan.trials.map((trial) => [trial.trial_id, "completed"])), events: [], report, error: null };
  store.db.prepare("INSERT INTO workspace_runs(run_id, plan_id, status, created_at, run_json) VALUES (?, ?, ?, ?, ?)").run(run.runId, run.planId, run.status, run.createdAt, JSON.stringify(run));
  return run;
}

test("workspace releases publish accepted evidence, export safely and preserve rollback history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-workbench-release-"));
  const workspace = join(root, "workspace");
  const skillSource = join(root, "skill");
  const suiteSource = join(root, "suite.json");
  await mkdir(workspace);
  await mkdir(skillSource);
  await writeFile(join(skillSource, "SKILL.md"), "# Release Skill\n\nVersion one.\n");
  await writeFile(suiteSource, JSON.stringify({ suite_id: "release-suite", tasks: [
    { task_id: "one", family_id: "release", source_group: "one", split: "validation", prompt: "One", expected_output: "one", mock_outputs: {}, tags: [] },
    { task_id: "two", family_id: "release", source_group: "two", split: "validation", prompt: "Two", expected_output: "two", mock_outputs: {}, tags: [] },
  ] }));

  const skills = new WorkspaceSkillStore(workspace);
  const suites = new WorkspaceSuiteStore(workspace);
  const plans = new WorkspacePlanStore(workspace);
  const runs = new WorkspaceRunStore(workspace, { planStore: plans, suiteStore: suites, skillStore: skills });
  const releases = new WorkspaceReleaseStore(workspace, { skillStore: skills, planStore: plans, runStore: runs });
  t.after(async () => { await runs.close(); plans.close(); suites.close(); skills.close(); });

  const v1 = await skills.importFromDirectory({ sourcePath: skillSource });
  await writeFile(join(skillSource, "SKILL.md"), "# Release Skill\n\nVersion two.\n");
  const v2 = await skills.importFromDirectory({ sourcePath: skillSource, skillId: v1.skill.skillId });
  const suite = await suites.importFromFile(suiteSource);
  const agent = { id: "codex" as const, name: "Codex", installation: "found" as const, authentication: "unknown" as const, evaluationSupport: "exploratory" as const, executablePath: "/usr/bin/codex", version: "test", capabilities: ["structured-output"], detectedAt: new Date().toISOString(), evidence: [] };
  const planV2 = plans.createPlan({ name: "Release v2", experimentType: "version-comparison", suiteVersion: suite.version, incumbentVersion: v1.version, candidateVersion: v2.version, agent, repeats: 1, timeoutMs: 30_000, concurrency: 1 });
  const acceptedV2 = persistRun(runs, planV2, "run-11111111-1111-4111-8111-111111111111", acceptedGate);

  const before = await releases.getSkillReleases(v1.skill.skillId);
  assert.equal(before.currentDigest, null);
  assert.equal(before.eligibleRuns[0].runId, acceptedV2.runId);
  const first = await releases.publish(v1.skill.skillId, { runId: acceptedV2.runId, expectedCurrentDigest: null });
  assert.equal(first.release.skill_digest, v2.version.treeDigest);
  assert.deepEqual(first.release.evaluation_refs, [acceptedV2.runId, acceptedGate.decision_id]);

  const receipt = await releases.exportRelease(v1.skill.skillId, first.release.release_id, "codex");
  assert.match(receipt.output_dir, new RegExp(`\\.skillbenchmark/exports/${v1.skill.skillId}/`));
  assert.match(await readFile(join(receipt.output_dir, "SKILL.md"), "utf8"), /Version two/);
  assert.match(await readFile(join(receipt.output_dir, "export-receipt.json"), "utf8"), /codex/);

  await writeFile(join(skillSource, "SKILL.md"), "# Release Skill\n\nVersion three.\n");
  const v3 = await skills.importFromDirectory({ sourcePath: skillSource, skillId: v1.skill.skillId });
  const planV3 = plans.createPlan({ name: "Release v3", experimentType: "version-comparison", suiteVersion: suite.version, incumbentVersion: v2.version, candidateVersion: v3.version, agent, repeats: 1, timeoutMs: 30_000, concurrency: 1 });
  const acceptedV3 = persistRun(runs, planV3, "run-22222222-2222-4222-8222-222222222222", { ...acceptedGate, decision_id: "decision-v3" });
  const second = await releases.publish(v1.skill.skillId, { runId: acceptedV3.runId, expectedCurrentDigest: v2.version.treeDigest });
  await assert.rejects(releases.rollback(v1.skill.skillId, first.release.release_id, "stale-digest"), /current digest changed/i);
  await releases.rollback(v1.skill.skillId, first.release.release_id, second.release.skill_digest);

  const after = await releases.getSkillReleases(v1.skill.skillId);
  assert.equal(after.currentDigest, v2.version.treeDigest);
  assert.equal(after.releases.length, 2);
  assert.equal(after.events.map((event) => event.event).join(","), "published,published,rollback");
  assert.equal(after.releases.find((item) => item.release.release_id === first.release.release_id)?.isCurrent, true);
});

test("workspace releases reject incomplete or non-accepted evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-workbench-release-reject-"));
  const workspace = join(root, "workspace");
  const skillSource = join(root, "skill");
  const suiteSource = join(root, "suite.json");
  await mkdir(workspace);
  await mkdir(skillSource);
  await writeFile(join(skillSource, "SKILL.md"), "# Reject Skill\n");
  await writeFile(suiteSource, JSON.stringify({ suite_id: "reject-suite", tasks: [{ task_id: "one", family_id: "reject", source_group: "one", split: "validation", prompt: "One", expected_output: "one", mock_outputs: {}, tags: [] }] }));
  const skills = new WorkspaceSkillStore(workspace);
  const suites = new WorkspaceSuiteStore(workspace);
  const plans = new WorkspacePlanStore(workspace);
  const runs = new WorkspaceRunStore(workspace, { planStore: plans, suiteStore: suites, skillStore: skills });
  const releases = new WorkspaceReleaseStore(workspace, { skillStore: skills, planStore: plans, runStore: runs });
  t.after(async () => { await runs.close(); plans.close(); suites.close(); skills.close(); });
  const v1 = await skills.importFromDirectory({ sourcePath: skillSource });
  await writeFile(join(skillSource, "SKILL.md"), "# Reject Skill\n\nCandidate.\n");
  const v2 = await skills.importFromDirectory({ sourcePath: skillSource, skillId: v1.skill.skillId });
  const suite = await suites.importFromFile(suiteSource);
  const agent = { id: "codex" as const, name: "Codex", installation: "found" as const, authentication: "unknown" as const, evaluationSupport: "exploratory" as const, executablePath: "/usr/bin/codex", version: "test", capabilities: [], detectedAt: new Date().toISOString(), evidence: [] };
  const plan = plans.createPlan({ name: "Rejected", experimentType: "version-comparison", suiteVersion: suite.version, incumbentVersion: v1.version, candidateVersion: v2.version, agent, repeats: 1, timeoutMs: 30_000, concurrency: 1 });
  const run = persistRun(runs, plan, "run-33333333-3333-4333-8333-333333333333", { ...acceptedGate, decision_id: "decision-inconclusive", status: "inconclusive" });
  assert.equal((await releases.getSkillReleases(v1.skill.skillId)).eligibleRuns.length, 0);
  await assert.rejects(releases.publish(v1.skill.skillId, { runId: run.runId, expectedCurrentDigest: null }), /accepted GateDecision/i);

  const malformed = persistRun(runs, plan, "run-44444444-4444-4444-8444-444444444444", acceptedGate);
  malformed.report!.results = [{}] as RunReport["results"];
  runs.db.prepare("UPDATE workspace_runs SET run_json = ? WHERE run_id = ?").run(JSON.stringify(malformed), malformed.runId);
  assert.equal((await releases.getSkillReleases(v1.skill.skillId)).eligibleRuns.length, 0);
  await assert.rejects(releases.publish(v1.skill.skillId, { runId: malformed.runId, expectedCurrentDigest: null }), /accepted GateDecision/i);
});
