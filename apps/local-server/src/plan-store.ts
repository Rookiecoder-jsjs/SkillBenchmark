import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import type { ConditionId, RunPlan } from "../../../packages/contracts/src/types.ts";
import { sha256, stableJson } from "../../../packages/core/src/hash.ts";
import { createRunPlan } from "../../../packages/core/src/plan.ts";
import type { AgentDiscovery } from "./discovery.ts";
import type { SkillVersion } from "./skill-store.ts";
import type { WorkspaceSuiteVersion } from "./suite-store.ts";

export type ExperimentType = "trial" | "effectiveness" | "version-comparison";
const MAX_PLAN_TRIALS = 500;
const MAX_RUN_DURATION_MS = 60 * 60 * 1_000;
export interface SkillBinding { skillId: string; versionId: string; treeDigest: string }
export interface WorkbenchPlan {
  planId: string;
  name: string;
  experimentType: ExperimentType;
  status: "ready";
  createdAt: string;
  planDigest: string;
  suite: { suiteId: string; versionId: string; digest: string; label: string; taskCount: number };
  agent: { id: string; name: string; executablePath: string; version: string | null; evaluationSupport: string; model: string };
  bindings: Partial<Record<ConditionId, SkillBinding | null>>;
  corePlan: RunPlan;
}

function planFromJson(value: string): WorkbenchPlan {
  const plan = JSON.parse(value) as WorkbenchPlan;
  if (!plan.agent.model) plan.agent.model = plan.corePlan.profiles[0]?.model ?? "default";
  return plan;
}

export class WorkspacePlanStore {
  readonly db: DatabaseSync;
  constructor(workspaceRoot: string) {
    const stateRoot = join(resolve(workspaceRoot), ".skillbenchmark");
    mkdirSync(stateRoot, { recursive: true });
    this.db = new DatabaseSync(join(stateRoot, "metadata.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workspace_plans (
        plan_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        plan_json TEXT NOT NULL
      );
    `);
  }

  createPlan(input: { name: string; experimentType: ExperimentType; suiteVersion: WorkspaceSuiteVersion; incumbentVersion?: SkillVersion; candidateVersion: SkillVersion; agent: AgentDiscovery; repeats: number; timeoutMs: number; concurrency: number; model?: string }): WorkbenchPlan {
    if (!input.name.trim() || input.name.length > 160) throw new Error("Plan name must contain 1 to 160 characters");
    if (input.agent.installation !== "found" || !input.agent.executablePath) throw new Error("Selected Agent is not installed");
    if (!Number.isInteger(input.repeats) || input.repeats < 1 || input.repeats > 10) throw new Error("repeats must be between 1 and 10");
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 3_600_000) throw new Error("timeoutMs must be between 1000 and 3600000");
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) throw new Error("concurrency must be between 1 and 4");
    const model = input.model?.trim() || "default";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error("model must be 'default' or a valid model identifier");
    if (input.experimentType === "version-comparison") {
      if (!input.incumbentVersion) throw new Error("Version comparison requires an incumbent version");
      if (input.incumbentVersion.skillId !== input.candidateVersion.skillId) throw new Error("Version comparison requires versions from the same Skill");
      if (input.incumbentVersion.versionId === input.candidateVersion.versionId) throw new Error("Version comparison requires two different versions");
    }
    const conditions: ConditionId[] = input.experimentType === "trial" ? ["candidate"] : input.experimentType === "effectiveness" ? ["none", "candidate"] : ["none", "incumbent", "candidate"];
    const expectedTrials = input.suiteVersion.taskCount * conditions.length * input.repeats;
    if (expectedTrials > MAX_PLAN_TRIALS) throw new Error(`Plan requires ${expectedTrials} Trials; interactive runs are limited to ${MAX_PLAN_TRIALS}`);
    const profile = { profile_id: input.agent.id, platform: input.agent.id, platform_version: input.agent.version ?? "unknown", adapter_version: "0.1", model, config_digest: sha256(stableJson({ executable_path: input.agent.executablePath, version: input.agent.version, model, capabilities: input.agent.capabilities })), capabilities: input.agent.capabilities };
    const planId = `plan-${randomUUID()}`;
    const corePlan = createRunPlan(input.suiteVersion.snapshot, { runId: planId, conditions, repeats: input.repeats, profiles: [profile], budget: { max_trials: expectedTrials, concurrency: input.concurrency, timeout_ms: input.timeoutMs, max_duration_ms: Math.min(MAX_RUN_DURATION_MS, input.timeoutMs * Math.max(1, expectedTrials)) } });
    const bindings: WorkbenchPlan["bindings"] = { candidate: { skillId: input.candidateVersion.skillId, versionId: input.candidateVersion.versionId, treeDigest: input.candidateVersion.treeDigest } };
    if (input.experimentType === "effectiveness") bindings.none = null;
    if (input.experimentType === "version-comparison") {
      bindings.none = null;
      bindings.incumbent = { skillId: input.incumbentVersion!.skillId, versionId: input.incumbentVersion!.versionId, treeDigest: input.incumbentVersion!.treeDigest };
    }
    const createdAt = new Date().toISOString();
    const suite = { suiteId: input.suiteVersion.suiteId, versionId: input.suiteVersion.versionId, digest: input.suiteVersion.digest, label: input.suiteVersion.label, taskCount: input.suiteVersion.taskCount };
    const agent = { id: input.agent.id, name: input.agent.name, executablePath: input.agent.executablePath, version: input.agent.version, evaluationSupport: input.agent.evaluationSupport, model };
    const frozen = { name: input.name.trim(), experimentType: input.experimentType, status: "ready" as const, createdAt, suite, agent, bindings, corePlan };
    const plan: WorkbenchPlan = { planId, ...frozen, planDigest: sha256(stableJson(frozen)) };
    this.db.prepare("INSERT INTO workspace_plans(plan_id, name, plan_digest, status, created_at, plan_json) VALUES (?, ?, ?, ?, ?, ?)").run(plan.planId, plan.name, plan.planDigest, plan.status, plan.createdAt, JSON.stringify(plan));
    return plan;
  }

  listPlans(): WorkbenchPlan[] {
    const rows = this.db.prepare("SELECT plan_json FROM workspace_plans ORDER BY created_at DESC").all() as unknown as Array<{ plan_json: string }>;
    return rows.map((row) => planFromJson(row.plan_json));
  }

  getPlan(planId: string): WorkbenchPlan {
    const row = this.db.prepare("SELECT plan_json FROM workspace_plans WHERE plan_id = ?").get(planId) as { plan_json: string } | undefined;
    if (!row) throw new Error(`Plan not found: ${planId}`);
    return planFromJson(row.plan_json);
  }

  close(): void { this.db.close(); }
}
