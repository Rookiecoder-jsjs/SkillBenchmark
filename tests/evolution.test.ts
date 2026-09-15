import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidenceView, createCandidateSnapshot, maintainWiki, writeEvolutionArtifacts } from "../packages/core/src/evolution.ts";
import { importSkillSnapshot } from "../packages/core/src/snapshot.ts";
import { loadSuite } from "../packages/core/src/suite.ts";
import { createRunPlan } from "../packages/core/src/plan.ts";
import { executePlan } from "../packages/core/src/pipeline.ts";
import { attachStatistics } from "../packages/core/src/statistics.ts";

test("evolution filters evidence to train and preserves the parent Skill", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  const plan = createRunPlan(suite, { split: "train", repeats: 1, runId: "run-evolution" });
  const report = attachStatistics(executePlan(suite, plan));
  const evidence = buildEvidenceView(suite, report, "train");
  assert.ok(evidence.items.length > 0);
  assert.ok(evidence.items.every((item) => item.task_id !== "json-001"));
  assert.equal(JSON.stringify(evidence).includes("expected_output"), false);
  const patterns = maintainWiki(evidence);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].status, "hypothesis");

  const parentDir = await mkdtemp(join(tmpdir(), "skillbenchmark-parent-"));
  await writeFile(join(parentDir, "SKILL.md"), "# Example Skill\n");
  const parent = await importSkillSnapshot(parentDir, "parent");
  const parentText = await readFile(join(parentDir, "SKILL.md"), "utf8");
  const candidateDir = await mkdtemp(join(tmpdir(), "skillbenchmark-candidate-"));
  const candidate = await createCandidateSnapshot(parentDir, parent, patterns[0], candidateDir);
  assert.notEqual(candidate.snapshot.tree_digest, parent.tree_digest);
  assert.ok(candidate.proposal.diff.some((entry) => entry.path === "SKILL.md" && entry.change === "changed"));
  assert.equal(await readFile(join(parentDir, "SKILL.md"), "utf8"), parentText);
  const evolutionDir = await mkdtemp(join(tmpdir(), "skillbenchmark-evolution-"));
  await writeEvolutionArtifacts(evolutionDir, evidence, patterns, candidate.proposal);
  assert.match(await readFile(join(evolutionDir, "evidence-view.json"), "utf8"), /source_run_id/);
});
