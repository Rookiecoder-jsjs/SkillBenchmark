import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Release } from "../../../packages/contracts/src/types.ts";
import { FileRegistry, type RegistryEvent } from "../../../packages/core/src/registry.ts";
import { importSkillSnapshot } from "../../../packages/core/src/snapshot.ts";
import { evaluateGate } from "../../../packages/core/src/statistics.ts";
import type { WorkbenchPlan, WorkspacePlanStore } from "./plan-store.ts";
import type { WorkbenchRun, WorkspaceRunStore } from "./run-store.ts";
import type { SkillVersion, WorkspaceSkillStore } from "./skill-store.ts";

export type ReleasePlatform = "codex" | "claude-code";

export interface EligibleReleaseRun {
  runId: string;
  name: string;
  finishedAt: string;
  decisionId: string;
  candidateVersionId: string;
  candidateTreeDigest: string;
  suite: WorkbenchPlan["suite"];
  agent: Pick<WorkbenchPlan["agent"], "id" | "name" | "model" | "version" | "evaluationSupport">;
}

export interface WorkspaceReleaseItem {
  release: Release;
  isCurrent: boolean;
  version: Pick<SkillVersion, "versionId" | "ordinal" | "label" | "treeDigest"> | null;
}

export interface WorkspaceReleaseView {
  skillId: string;
  currentDigest: string | null;
  releases: WorkspaceReleaseItem[];
  events: RegistryEvent[];
  eligibleRuns: EligibleReleaseRun[];
}

export interface ExportReceipt {
  release_id: string;
  platform: string;
  output_dir: string;
  skill_digest: string;
  exported_at: string;
}

const SKILL_ID = /^skill-[0-9a-f-]{36}$/;
const RELEASE_ID = /^release-[0-9a-f-]{36}$/;

function hasCompleteTrialMatrix(run: WorkbenchRun): boolean {
  const results = run.report?.results;
  const plannedTrials = run.report?.plan.trials;
  if (!Array.isArray(results) || !Array.isArray(plannedTrials) || results.length !== run.trialCount || plannedTrials.length !== run.trialCount) return false;
  const expectedIds = new Set(plannedTrials.map((trial) => trial.trial_id));
  const observedIds = new Set<string>();
  for (const result of results) {
    if (!result?.spec || !result.receipt || !result.grade || !Array.isArray(result.events)) return false;
    const trialId = result.spec.trial_id;
    if (typeof trialId !== "string" || !expectedIds.has(trialId) || observedIds.has(trialId)) return false;
    if (result.receipt.trial_id !== trialId || result.grade.trial_id !== trialId || run.trialStatuses[trialId] !== result.receipt.status) return false;
    if (typeof result.receipt.started_at !== "string" || typeof result.receipt.finished_at !== "string") return false;
    if (!Number.isFinite(result.grade.metrics?.exact_match)) return false;
    observedIds.add(trialId);
  }
  return observedIds.size === expectedIds.size;
}

function matchesFrozenPlan(run: WorkbenchRun, plan: WorkbenchPlan): boolean {
  const reportPlan = run.report?.plan;
  if (!reportPlan) return false;
  const expectedTrials = plan.corePlan.trials.map((trial) => ({ ...trial, run_id: run.runId, trial_id: trial.trial_id.replace(plan.corePlan.run_id, run.runId) }));
  return reportPlan.run_id === run.runId
    && reportPlan.suite_id === plan.corePlan.suite_id
    && reportPlan.suite_digest === plan.corePlan.suite_digest
    && reportPlan.fingerprint === plan.corePlan.fingerprint
    && reportPlan.repeats === plan.corePlan.repeats
    && reportPlan.mode === plan.corePlan.mode
    && reportPlan.load_method === plan.corePlan.load_method
    && JSON.stringify(reportPlan.profiles) === JSON.stringify(plan.corePlan.profiles)
    && JSON.stringify(reportPlan.conditions) === JSON.stringify(plan.corePlan.conditions)
    && JSON.stringify(reportPlan.budget) === JSON.stringify(plan.corePlan.budget)
    && JSON.stringify(reportPlan.trials) === JSON.stringify(expectedTrials);
}

export class WorkspaceReleaseStore {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly skillStore: WorkspaceSkillStore;
  readonly planStore: WorkspacePlanStore;
  readonly runStore: WorkspaceRunStore;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string, dependencies: { skillStore: WorkspaceSkillStore; planStore: WorkspacePlanStore; runStore: WorkspaceRunStore }) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.stateRoot = join(this.workspaceRoot, ".skillbenchmark");
    this.skillStore = dependencies.skillStore;
    this.planStore = dependencies.planStore;
    this.runStore = dependencies.runStore;
  }

  private validateSkillId(skillId: string): void {
    if (!SKILL_ID.test(skillId)) throw new Error("Skill ID is invalid");
    this.skillStore.getSkill(skillId);
  }

  private async registry(skillId: string): Promise<FileRegistry> {
    this.validateSkillId(skillId);
    const registry = new FileRegistry(join(this.stateRoot, "registries", skillId));
    await registry.open();
    return registry;
  }

  private evidence(skillId: string, run: WorkbenchRun): EligibleReleaseRun | null {
    if (run.status !== "completed" || !run.report || run.completedTrials !== run.trialCount || !hasCompleteTrialMatrix(run)) return null;
    let plan: WorkbenchPlan;
    try { plan = this.planStore.getPlan(run.planId); } catch { return null; }
    const candidate = plan.bindings.candidate;
    if (plan.experimentType !== "version-comparison" || !candidate || candidate.skillId !== skillId || !plan.bindings.incumbent) return null;
    if (run.report.run_id !== run.runId || !matchesFrozenPlan(run, plan) || run.report.plan.suite_digest !== plan.suite.digest) return null;
    if (!run.report.gate || run.report.gate.status !== "accept") return null;
    const recalculated = evaluateGate(run.report, run.report.gate.policy);
    if (recalculated.status !== "accept") return null;
    let version: SkillVersion;
    try { version = this.skillStore.getVersion(candidate.versionId); } catch { return null; }
    if (version.skillId !== skillId || version.treeDigest !== candidate.treeDigest) return null;
    return { runId: run.runId, name: run.name, finishedAt: run.finishedAt!, decisionId: run.report.gate.decision_id, candidateVersionId: candidate.versionId, candidateTreeDigest: candidate.treeDigest, suite: plan.suite, agent: { id: plan.agent.id, name: plan.agent.name, model: plan.agent.model, version: plan.agent.version, evaluationSupport: plan.agent.evaluationSupport } };
  }

  private async withLock<T>(skillId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(skillId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.locks.set(skillId, settled);
    try { return await current; }
    finally { if (this.locks.get(skillId) === settled) this.locks.delete(skillId); }
  }

  async getSkillReleases(skillId: string): Promise<WorkspaceReleaseView> {
    const registry = await this.registry(skillId);
    const currentDigest = registry.currentDigest();
    const versions = this.skillStore.getSkill(skillId).versions;
    const versionByDigest = new Map(versions.map((version) => [version.treeDigest, version]));
    const releaseRecords = registry.listReleases();
    const releasedDigests = new Set(releaseRecords.map((release) => release.skill_digest));
    const eligibleRuns = this.runStore.listCompletedRuns().map((run) => this.evidence(skillId, run)).filter((run): run is EligibleReleaseRun => Boolean(run)).filter((run) => !releasedDigests.has(run.candidateTreeDigest));
    const releases = releaseRecords.slice().reverse().map((release) => {
      const version = versionByDigest.get(release.skill_digest);
      return { release, isCurrent: release.skill_digest === currentDigest, version: version ? { versionId: version.versionId, ordinal: version.ordinal, label: version.label, treeDigest: version.treeDigest } : null };
    });
    return { skillId, currentDigest, releases, events: registry.listEvents(), eligibleRuns };
  }

  async publish(skillId: string, input: { runId: string; expectedCurrentDigest: string | null }): Promise<WorkspaceReleaseItem> {
    return this.withLock(skillId, async () => {
      const registry = await this.registry(skillId);
      const run = this.runStore.getRun(input.runId);
      const evidence = this.evidence(skillId, run);
      if (!evidence) throw new Error("Release requires a completed version-comparison Run with an accepted GateDecision and matching candidate evidence");
      if (registry.listReleases().some((release) => release.skill_digest === evidence.candidateTreeDigest)) throw new Error("This Skill version was already released; use rollback to restore it");
      const workRoot = join(this.stateRoot, "work");
      await mkdir(workRoot, { recursive: true });
      const temporary = await mkdtemp(join(workRoot, "release-"));
      const skillRoot = join(temporary, "skill");
      try {
        const version = await this.skillStore.materializeVersion(evidence.candidateVersionId, skillRoot);
        const snapshot = await importSkillSnapshot(skillRoot, version.label);
        if (snapshot.tree_digest !== evidence.candidateTreeDigest) throw new Error("Release candidate failed digest verification");
        const report = run.report!;
        const release = await registry.publish(snapshot, skillRoot, report.gate!, [run.runId, report.gate!.decision_id], [`agent:${evidence.agent.id}`, `model:${evidence.agent.model}`, `suite:${evidence.suite.digest}`], input.expectedCurrentDigest);
        return { release, isCurrent: true, version: { versionId: version.versionId, ordinal: version.ordinal, label: version.label, treeDigest: version.treeDigest } };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }

  async exportRelease(skillId: string, releaseId: string, platform: ReleasePlatform): Promise<ExportReceipt> {
    if (!RELEASE_ID.test(releaseId)) throw new Error("Release ID is invalid");
    if (platform !== "codex" && platform !== "claude-code") throw new Error("Export platform is invalid");
    return this.withLock(skillId, async () => {
      const registry = await this.registry(skillId);
      const outputDir = join(this.stateRoot, "exports", skillId, `${releaseId}-${platform}-${randomUUID()}`);
      return registry.exportRelease(releaseId, platform, outputDir) as Promise<ExportReceipt>;
    });
  }

  async rollback(skillId: string, releaseId: string, expectedCurrentDigest: string): Promise<WorkspaceReleaseView> {
    if (!RELEASE_ID.test(releaseId)) throw new Error("Release ID is invalid");
    return this.withLock(skillId, async () => {
      const registry = await this.registry(skillId);
      const target = registry.getRelease(releaseId);
      if (target.skill_digest === registry.currentDigest()) throw new Error("Release is already current");
      await registry.rollback(releaseId, expectedCurrentDigest);
      return this.getSkillReleases(skillId);
    });
  }
}
