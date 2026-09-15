import { randomUUID } from "node:crypto";
import type { Budget, ConditionId, RunPlan, RunnerProfile, SuiteSnapshot, TrialSpec } from "../../contracts/src/types.ts";
import { sha256, stableJson } from "./hash.ts";

export interface PlanOptions {
  runId?: string;
  conditions?: ConditionId[];
  repeats?: number;
  budget?: Partial<Budget>;
  profiles?: RunnerProfile[];
  split?: "train" | "validation" | "test";
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
    max_attempts: options.budget?.max_attempts ?? Number.MAX_SAFE_INTEGER,
    concurrency: options.budget?.concurrency ?? 1,
    timeout_ms: options.budget?.timeout_ms ?? 30_000,
  };
  if (repeats < 1 || !Number.isInteger(repeats)) throw new Error("repeats must be a positive integer");
  if (conditions.length === 0) throw new Error("at least one condition is required");
  const profiles = options.profiles ?? [defaultProfile];
  const tasks = suite.tasks.filter((task) => !options.split || task.split === options.split);
  const expectedTrials = tasks.length * profiles.length * conditions.length * repeats;
  if (expectedTrials > budget.max_trials) throw new Error(`plan requires ${expectedTrials} trials, over max_trials=${budget.max_trials}`);
  const runId = options.runId ?? `run-${randomUUID()}`;
  const fingerprintInput = {
    suite_id: suite.suite_id,
    suite_digest: suite.digest,
    profiles,
    budget,
    repeats,
    split: options.split ?? null,
    schedule: { order: "task-profile-condition-repeat" },
  };
  const trials: TrialSpec[] = [];
  for (const task of tasks) for (const profile of profiles) for (const condition_id of conditions) for (let repeat_index = 1; repeat_index <= repeats; repeat_index++) {
    trials.push({ trial_id: `${runId}-${task.task_id}-${profile.profile_id}-${condition_id}-${repeat_index}`, run_id: runId, task_id: task.task_id, profile_id: profile.profile_id, condition_id, repeat_index, attempt: 1 });
  }
  return { schema_version: "0.1", run_id: runId, suite_id: suite.suite_id, suite_digest: suite.digest, profiles, conditions, repeats, budget, fingerprint: sha256(stableJson(fingerprintInput)), trials };
}
