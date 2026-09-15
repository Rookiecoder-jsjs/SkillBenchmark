export const SCHEMA_VERSION = "0.1" as const;

export type Split = "train" | "validation" | "test";
export type ConditionId = "none" | "incumbent" | "candidate";
export type TrialStatus = "completed" | "errored" | "timed_out" | "cancelled";
export type GradeOutcome = "pass" | "fail" | "ungradable";

export interface SkillSnapshot {
  schema_version: typeof SCHEMA_VERSION;
  skill_id: string;
  label: string;
  tree_digest: string;
  file_manifest: FileManifestEntry[];
  requirements: string[];
}

export interface FileManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  executable: boolean;
  symlink?: string;
}

export interface Task {
  task_id: string;
  family_id: string;
  source_group: string;
  split: Split;
  prompt: string;
  expected_output: string;
  mock_outputs: Partial<Record<ConditionId, string>>;
  tags: string[];
}

export interface SuiteSnapshot {
  schema_version: typeof SCHEMA_VERSION;
  suite_id: string;
  label: string;
  digest: string;
  tasks: Task[];
  split_policy: string;
  metric_policy: string;
}

export interface RunnerProfile {
  profile_id: string;
  platform: string;
  platform_version: string;
  adapter_version: string;
  model: string;
  config_digest: string;
  capabilities: string[];
}

export interface Budget {
  max_trials: number;
  max_attempts: number;
  concurrency: number;
  timeout_ms: number;
}

export interface RunPlan {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  suite_id: string;
  suite_digest: string;
  profiles: RunnerProfile[];
  conditions: ConditionId[];
  repeats: number;
  budget: Budget;
  fingerprint: string;
  trials: TrialSpec[];
}

export interface TrialSpec {
  trial_id: string;
  run_id: string;
  task_id: string;
  profile_id: string;
  condition_id: ConditionId;
  repeat_index: number;
  attempt: number;
}

export interface TraceEvent {
  schema_version: typeof SCHEMA_VERSION;
  event_id: string;
  trial_id: string;
  seq: number;
  timestamp: string;
  producer: "adapter" | "grader";
  kind: string;
  data: Record<string, unknown>;
}

export interface Artifact {
  trial_id: string;
  output: string;
  output_sha256: string;
}

export interface ExecutionReceipt {
  trial_id: string;
  status: TrialStatus;
  started_at: string;
  finished_at: string;
  artifact: Artifact | null;
  failure_reason: string | null;
}

export interface Grade {
  schema_version: typeof SCHEMA_VERSION;
  trial_id: string;
  grader_digest: string;
  outcome: GradeOutcome;
  metrics: { exact_match: number };
  assertions: { name: string; passed: boolean; detail: string }[];
  evidence_refs: string[];
}

export interface TrialResult {
  spec: TrialSpec;
  receipt: ExecutionReceipt;
  events: TraceEvent[];
  grade: Grade;
}

export interface RunReport {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  plan: RunPlan;
  results: TrialResult[];
  summary: {
    by_condition: Record<string, { total: number; passed: number; success_rate: number | null }>;
    contrasts: { left: ConditionId; right: ConditionId; effect: number | null; comparable_trials: number }[];
  };
}
