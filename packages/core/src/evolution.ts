import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { EvidenceView, GateDecision, Proposal, RunReport, SkillSnapshot, SuiteSnapshot, WikiPattern } from "../../contracts/src/types.ts";
import { importSkillSnapshot } from "./snapshot.ts";

export function buildEvidenceView(suite: SuiteSnapshot, report: RunReport, split: "train" | "validation" = "train"): EvidenceView {
  const tasks = new Map(suite.tasks.filter((task) => task.split === split).map((task) => [task.task_id, task]));
  return {
    schema_version: "0.1",
    source_run_id: report.run_id,
    split,
    items: report.results.filter((result) => tasks.has(result.spec.task_id)).map((result) => ({ trial_id: result.spec.trial_id, task_id: result.spec.task_id, family_id: tasks.get(result.spec.task_id)?.family_id ?? "unknown", condition_id: result.spec.condition_id, status: result.receipt.status, outcome: result.grade.outcome, metrics: result.grade.metrics, event_kinds: result.events.map((event) => event.kind) })),
  };
}

export function maintainWiki(evidence: EvidenceView, previous: WikiPattern[] = []): WikiPattern[] {
  const failures = evidence.items.filter((item) => item.outcome === "fail");
  const families = [...new Set(failures.map((item) => item.family_id))];
  if (!failures.length) return previous;
  const pattern: WikiPattern = {
    pattern_id: `pattern-${randomUUID()}`,
    revision: 1,
    scope: { split: evidence.split, families },
    observations: [`${failures.length} 个训练 Trial 产生可评分失败`, `失败涉及条件：${[...new Set(failures.map((item) => item.condition_id))].join(", ")}`],
    hypotheses: ["在修改前明确边界条件并保留可复现证据，可能减少同类失败。"],
    counterexamples: [],
    evidence_refs: failures.map((item) => item.trial_id),
    status: "hypothesis",
  };
  return [...previous, pattern];
}

export interface CandidateResult {
  snapshot: SkillSnapshot;
  proposal: Proposal;
  output_dir: string;
}

export function applyValidationGate(proposal: Proposal, gate: GateDecision): Proposal {
  return { ...proposal, validation_status: gate.status };
}

export async function createCandidateSnapshot(parentDir: string, parent: SkillSnapshot, pattern: WikiPattern, outputDir: string): Promise<CandidateResult> {
  await mkdir(resolve(outputDir), { recursive: true });
  await cp(resolve(parentDir), resolve(outputDir), { recursive: true, verbatimSymlinks: true });
  const skillFile = join(resolve(outputDir), "SKILL.md");
  const current = await readFile(skillFile, "utf8").catch(() => "# Skill\n");
  const addition = `\n\n## Iteration guidance\n\nBefore changing an implementation, list relevant input boundaries, reproduce the issue with a minimal check, and verify the fix against the same check. If reproduction is unavailable, state the missing condition instead of treating an assumption as verified.\n`;
  await writeFile(skillFile, current.endsWith("\n") ? `${current}${addition}` : `${current}\n${addition}`);
  const candidate = await importSkillSnapshot(outputDir, `${parent.label} candidate`);
  const parentByPath = new Map(parent.file_manifest.map((entry) => [entry.path, entry]));
  const candidateByPath = new Map(candidate.file_manifest.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...parentByPath.keys(), ...candidateByPath.keys()])].sort();
  const diff: Proposal["diff"] = [];
  for (const path of paths) {
    const before = parentByPath.get(path);
    const after = candidateByPath.get(path);
    if (!before && after) diff.push({ path, change: "added", detail: `added ${after.bytes} bytes` });
    else if (before && !after) diff.push({ path, change: "removed", detail: `removed ${before.bytes} bytes` });
    else if (before && after && before.sha256 !== after.sha256) diff.push({ path, change: "changed", detail: `${before.sha256.slice(0, 12)} → ${after.sha256.slice(0, 12)}` });
  }
  const proposal: Proposal = { proposal_id: `proposal-${randomUUID()}`, parent_digest: parent.tree_digest, candidate_digest: candidate.tree_digest, diff, hypothesis: pattern.hypotheses[0] ?? "候选修改应改善训练失败。", evidence_refs: pattern.evidence_refs, validation_status: "pending" };
  return { snapshot: candidate, proposal, output_dir: resolve(outputDir) };
}

export async function writeEvolutionArtifacts(outputDir: string, evidence: EvidenceView, patterns: WikiPattern[], proposal?: Proposal): Promise<void> {
  await mkdir(resolve(outputDir), { recursive: true });
  await writeFile(join(resolve(outputDir), "evidence-view.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(join(resolve(outputDir), "wiki.json"), `${JSON.stringify(patterns, null, 2)}\n`);
  if (proposal) await writeFile(join(resolve(outputDir), "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`);
}
