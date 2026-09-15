export const SCHEMA_VERSION = "0.1" as const;

export type Split = "train" | "validation" | "test";
export type ConditionId = "none" | "incumbent" | "candidate";
export type TrialStatus = "completed" | "errored" | "timed_out" | "cancelled";
export type GradeOutcome = "pass" | "fail" | "ungradable";
export type CapabilityStatus = "verified" | "exploratory" | "unsupported";
export type EvaluationMode = "controlled" | "native" | "coexistence";
export type LoadMethod = "explicit-file-read" | "prompt-inline" | "native";

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

export interface SuiteDiagnostics {
  errors: { code: string; message: string; task_ids?: string[] }[];
  warnings: { code: string; message: string }[];
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
  max_duration_ms?: number;
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
  mode: EvaluationMode;
  load_method: LoadMethod;
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
  producer: "platform" | "adapter" | "grader";
  kind: string;
  data: Record<string, unknown>;
}

export interface EnvironmentSnapshot {
  backend: string;
  image_digest: string;
  tool_versions: Record<string, string>;
  network_policy: "none" | "replay" | "live";
  isolation_receipt: { root_dir: string; hidden_mounts: string[]; user_config_visible: boolean };
}

export interface EnvironmentHandle {
  id: string;
  root_dir: string;
  workdir: string;
  public_input_path: string;
  skill_path: string | null;
  background_skill_paths?: string[];
  snapshot: EnvironmentSnapshot;
}

export interface CapabilityReport {
  adapter: string;
  platform: string;
  status: CapabilityStatus;
  version: string | null;
  capabilities: string[];
  evidence: string[];
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
  failure_kind?: "task" | "infrastructure" | "grader" | "cancelled" | null;
  usage?: { input_tokens: number | null; output_tokens: number | null; estimated_cost: number | null };
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
  comparisons?: ComparisonResult[];
  gate?: GateDecision;
}

export interface ComparisonResult {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  left: ConditionId;
  right: ConditionId;
  strata: string[];
  effect: number | null;
  interval: { lower: number; upper: number; level: number } | null;
  regressions: { task_id: string; profile_id: string; repeat_index: number }[];
  missingness: { missing_pairs: number; total_pairs: number };
  profile_id?: string;
}

export interface GatePolicy {
  min_iteration_gain: number;
  min_iteration_ci_lower: number;
  max_relative_none_loss: number;
  max_missing_pair_rate: number;
  max_key_regressions: number;
}

export interface GateDecision {
  decision_id: string;
  comparison_refs: string[];
  policy: GatePolicy;
  status: "accept" | "reject" | "inconclusive";
  reasons: string[];
}

export interface EvidenceView {
  schema_version: typeof SCHEMA_VERSION;
  source_run_id: string;
  split: "train" | "validation";
  items: { trial_id: string; task_id: string; family_id: string; condition_id: ConditionId; status: TrialStatus; outcome: GradeOutcome; metrics: Record<string, number>; event_kinds: string[] }[];
}

export interface WikiPattern {
  pattern_id: string;
  revision: number;
  scope: { split: string; families: string[] };
  observations: string[];
  hypotheses: string[];
  counterexamples: string[];
  evidence_refs: string[];
  status: "observed" | "hypothesis" | "supported" | "contradicted" | "superseded";
}

export interface Proposal {
  proposal_id: string;
  parent_digest: string;
  candidate_digest: string;
  diff: { path: string; change: "added" | "removed" | "changed"; detail: string }[];
  hypothesis: string;
  evidence_refs: string[];
  validation_status: "pending" | "accept" | "reject" | "inconclusive";
}

export interface Release {
  release_id: string;
  skill_digest: string;
  evaluation_refs: string[];
  scope: string[];
  audit_status: "exploratory" | "verified";
  timestamp: string;
  status: "published" | "superseded";
}
