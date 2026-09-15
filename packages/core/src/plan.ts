import { randomUUID } from "node:crypto";
import type { Budget, ConditionId, EvaluationMode, LoadMethod, RunPlan, RunnerProfile, SuiteSnapshot, TrialSpec } from "../../contracts/src/types.ts";
import { sha256, stableJson } from "./hash.ts";

export interface PlanOptions {
  runId?: string;
  conditions?: ConditionId[];
  repeats?: number;
  budget?: Partial<Budget>;
  profiles?: RunnerProfile[];
  split?: "train" | "validation" | "test";
  mode?: EvaluationMode;
  load_method?: LoadMethod;
}

const defaultProfile: RunnerProfile = {
  profile_id: "mock-node",
  platform: "mock",
  platform_version: "0.1",
  adapter_version: "0.1",
  model: "deterministic",
  config_digest: sha256("mock-node-default"),
  capabilities: ["mock", "structured-events"],
};

export function createRunPlan(suite: SuiteSnapshot, options: PlanOptions = {}): RunPlan {
  const conditions = options.conditions ?? ["none", "incumbent", "candidate"];
  const repeats = options.repeats ?? 3;
  const budget: Budget = {
    max_trials: options.budget?.max_trials ?? Number.MAX_SAFE_INTEGER,
    max_attempts: options.budget?.max_attempts ?? 1,
    concurrency: options.budget?.concurrency ?? 1,
    timeout_ms: options.budget?.timeout_ms ?? 30_000,
    max_duration_ms: options.budget?.max_duration_ms ?? 60_000,
  };
  for (const [name, value] of Object.entries(budget)) if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  if (repeats < 1 || !Number.isInteger(repeats)) throw new Error("repeats must be a positive integer");
  if (conditions.length === 0) throw new Error("at least one condition is required");
  const profiles = options.profiles ?? [defaultProfile];
  const mode = options.mode ?? "controlled";
  const load_method = options.load_method ?? (mode === "native" ? "native" : "explicit-file-read");
  if (mode === "native" && load_method !== "native") throw new Error("native mode requires native load_method");
  if (mode !== "native" && load_method === "native") throw new Error("native load_method requires native mode");
  const tasks = suite.tasks.filter((task) => !options.split || task.split === options.split);
  const expectedTrials = tasks.length * profiles.length * conditions.length * repeats;
  if (options.budget?.max_attempts === undefined) budget.max_attempts = Math.max(1, expectedTrials * 2);
  if (options.budget?.max_duration_ms === undefined) budget.max_duration_ms = Math.max(60_000, budget.timeout_ms * Math.max(1, expectedTrials));
  if (expectedTrials > budget.max_trials) throw new Error(`plan requires ${expectedTrials} trials, over max_trials=${budget.max_trials}`);
  if (expectedTrials > budget.max_attempts) throw new Error(`plan requires at least ${expectedTrials} attempts, over max_attempts=${budget.max_attempts}`);
  const runId = options.runId ?? `run-${randomUUID()}`;
  const fingerprintInput = {
    suite_id: suite.suite_id,
    suite_digest: suite.digest,
    profiles,
    budget,
    repeats,
    split: options.split ?? null,
    mode,
    load_method,
    schedule: { order: "task-profile-condition-repeat" },
  };
  const trials: TrialSpec[] = [];
  for (const task of tasks) for (const profile of profiles) for (const condition_id of conditions) for (let repeat_index = 1; repeat_index <= repeats; repeat_index++) {
    trials.push({ trial_id: `${runId}-${task.task_id}-${profile.profile_id}-${condition_id}-${repeat_index}`, run_id: runId, task_id: task.task_id, profile_id: profile.profile_id, condition_id, repeat_index, attempt: 1 });
  }
  return { schema_version: "0.1", run_id: runId, suite_id: suite.suite_id, suite_digest: suite.digest, profiles, conditions, repeats, budget, fingerprint: sha256(stableJson(fingerprintInput)), trials, mode, load_method };
}
