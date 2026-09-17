export interface RunEventLike {
  type?: string;
  trial_id?: string;
  timestamp?: string;
  event?: TraceEventLike;
}

export interface TraceEventLike {
  event_id?: string;
  trial_id?: string;
  seq?: number;
  timestamp?: string;
  producer: string;
  kind: string;
  data: Record<string, unknown>;
}

interface TrialLike {
  spec: { trial_id: string; task_id: string; profile_id: string; condition_id: string; repeat_index: number };
  receipt: {
    status: string;
    started_at: string;
    finished_at: string;
    artifact: { output: string; output_sha256: string } | null;
    failure_reason: string | null;
  };
  grade: { outcome: string; metrics: { exact_match: number } };
  events: TraceEventLike[];
}

interface ReportLike {
  summary: {
    by_condition: Record<string, { total: number; passed: number; success_rate: number | null }>;
    contrasts: Array<{ left: string; right: string; effect: number | null; comparable_trials: number }>;
  };
  results: TrialLike[];
}

export interface RunDetailSource {
  runId: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  events: RunEventLike[];
  report: ReportLike | null;
}

export interface ComparisonPlanSource {
  suite: { digest: string };
  agent: { id: string; model: string };
  bindings: { candidate?: { versionId: string; treeDigest: string } };
  corePlan: {
    fingerprint: string;
    profiles: Array<{ config_digest: string }>;
    conditions: string[];
    repeats: number;
    budget: { max_trials: number; max_attempts: number; concurrency: number; timeout_ms: number; max_duration_ms?: number };
    mode: string;
    load_method: string;
  };
}

export interface EventPresentation {
  category: "lifecycle" | "tool" | "message" | "platform";
  label: string;
  detail: string | null;
}

function elapsed(start: string | null | undefined, finish: string | null | undefined): number | null {
  if (!start || !finish) return null;
  const value = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstText(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return null;
}

function rawRecord(event: Pick<TraceEventLike, "data">): Record<string, unknown> | null {
  const raw = event.data.raw;
  if (typeof raw !== "string") return nestedRecord(raw);
  try { return nestedRecord(JSON.parse(raw)); } catch { return null; }
}

export function eventPresentation(event: Pick<TraceEventLike, "kind" | "producer" | "data">): EventPresentation {
  const parsed = rawRecord(event);
  const item = nestedRecord(parsed?.item) ?? nestedRecord(parsed?.content) ?? nestedRecord(parsed?.tool_use);
  const itemType = firstText(item, ["type", "name", "tool_name"]);
  const command = firstText(item, ["command", "input", "query"]) ?? firstText(parsed, ["command", "tool_name", "name"]);
  const toolLike = itemType && /tool|command|mcp|shell|computer|browser|file/i.test(itemType);
  if (toolLike || /tool|command|mcp/i.test(event.kind)) return { category: "tool", label: itemType ?? event.kind, detail: command };
  if (event.kind === "trial.started" || event.kind === "trial.finished" || event.kind === "skill.provisioned") return { category: "lifecycle", label: event.kind, detail: null };
  if (/message|result/i.test(event.kind)) return { category: "message", label: event.kind, detail: firstText(parsed, ["result", "text", "output"]) };
  return { category: event.producer === "platform" ? "platform" : "lifecycle", label: itemType ?? event.kind, detail: command };
}

export function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m ${((value % 60_000) / 1_000).toFixed(1)}s`;
}

export function buildRunDetailView(run: RunDetailSource, now = Date.now()) {
  const report = run.report;
  const reportResults = (Array.isArray(report?.results) ? report.results : []).filter(completeTrial);
  const wallTimeMs = elapsed(run.startedAt, run.finishedAt ?? (run.startedAt ? new Date(now).toISOString() : null));
  const trials = reportResults.map((result) => ({
    trialId: result.spec.trial_id,
    taskId: result.spec.task_id,
    condition: result.spec.condition_id,
    repeatIndex: result.spec.repeat_index,
    status: result.receipt.status,
    outcome: result.grade.outcome,
    exactMatch: result.grade.metrics.exact_match,
    durationMs: elapsed(result.receipt.started_at, result.receipt.finished_at),
    output: result.receipt.artifact?.output ?? null,
    outputSha256: result.receipt.artifact?.output_sha256 ?? null,
    failureReason: result.receipt.failure_reason,
  }));
  const aggregateTrialTimeMs = trials.reduce<number | null>((total, trial) => trial.durationMs === null ? total : (total ?? 0) + trial.durationMs, null);
  const reportEvents = reportResults.flatMap((result) => Array.isArray(result.events) ? result.events : []);
  const liveEvents = run.events.flatMap((progress) => progress.event ? [progress.event] : []);
  const events = new Map<string, TraceEventLike>();
  for (const event of [...reportEvents, ...liveEvents]) events.set(event.event_id ?? `${event.trial_id}:${event.seq}:${event.kind}:${event.timestamp}`, event);
  const timeline = [...events.values()].sort((left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? "") || (left.seq ?? 0) - (right.seq ?? 0)).map((event) => ({ ...event, ...eventPresentation(event) }));
  return {
    wallTimeMs,
    aggregateTrialTimeMs,
    totalTrials: trials.length,
    passedTrials: trials.filter((trial) => trial.outcome === "pass").length,
    conditions: Object.entries(report?.summary.by_condition ?? {}).map(([condition, summary]) => ({ condition, total: summary.total, passed: summary.passed, successRate: summary.success_rate })),
    contrasts: (report?.summary.contrasts ?? []).filter((contrast) => contrast.comparable_trials > 0),
    trials,
    timeline,
  };
}

function comparableJson(value: unknown): string { return JSON.stringify(value); }

function completeTrial(value: unknown): value is TrialLike {
  if (!value || typeof value !== "object") return false;
  const trial = value as Partial<TrialLike>;
  return Boolean(
    trial.spec
    && typeof trial.spec.trial_id === "string"
    && typeof trial.spec.task_id === "string"
    && typeof trial.spec.profile_id === "string"
    && typeof trial.spec.condition_id === "string"
    && typeof trial.spec.repeat_index === "number"
    && trial.receipt
    && typeof trial.receipt.status === "string"
    && trial.grade
    && typeof trial.grade.outcome === "string"
    && trial.grade.metrics
    && typeof trial.grade.metrics.exact_match === "number",
  );
}

function trialKey(result: TrialLike): string {
  return `${result.spec.task_id}|${result.spec.profile_id}|${result.spec.condition_id}|${result.spec.repeat_index}`;
}

function scoredValue(result: TrialLike | undefined): number | null {
  if (!result || result.grade.outcome === "ungradable") return null;
  return result.grade.metrics.exact_match;
}

export function buildRunComparison(leftRun: RunDetailSource, rightRun: RunDetailSource, leftPlan: ComparisonPlanSource, rightPlan: ComparisonPlanSource) {
  const reasons: string[] = [];
  if (!leftRun.report || !rightRun.report) reasons.push("最终报告缺失");
  const leftRawResults = Array.isArray(leftRun.report?.results) ? leftRun.report.results : [];
  const rightRawResults = Array.isArray(rightRun.report?.results) ? rightRun.report.results : [];
  const leftCompleteResults = leftRawResults.filter(completeTrial);
  const rightCompleteResults = rightRawResults.filter(completeTrial);
  if (leftCompleteResults.length !== leftRawResults.length || rightCompleteResults.length !== rightRawResults.length) reasons.push("部分 Trial 证据不完整");
  if (leftPlan.suite.digest !== rightPlan.suite.digest) reasons.push("Suite 不一致");
  if (leftPlan.agent.id !== rightPlan.agent.id) reasons.push("Agent 不一致");
  if (leftPlan.agent.model !== rightPlan.agent.model) reasons.push("模型不一致");
  if (comparableJson(leftPlan.corePlan.profiles.map((profile) => profile.config_digest)) !== comparableJson(rightPlan.corePlan.profiles.map((profile) => profile.config_digest))) reasons.push("Runner 配置不一致");
  if (comparableJson(leftPlan.corePlan.conditions) !== comparableJson(rightPlan.corePlan.conditions)) reasons.push("条件矩阵不一致");
  if (leftPlan.corePlan.repeats !== rightPlan.corePlan.repeats) reasons.push("重复次数不一致");
  if (comparableJson(leftPlan.corePlan.budget) !== comparableJson(rightPlan.corePlan.budget)) reasons.push("预算不一致");
  if (leftPlan.corePlan.mode !== rightPlan.corePlan.mode || leftPlan.corePlan.load_method !== rightPlan.corePlan.load_method) reasons.push("执行模式不一致");
  const leftSkill = leftPlan.bindings.candidate;
  const rightSkill = rightPlan.bindings.candidate;
  const skillChanged = Boolean(leftSkill?.treeDigest && rightSkill?.treeDigest && leftSkill.treeDigest !== rightSkill.treeDigest);
  const comparability = reasons.length ? "descriptive" as const : skillChanged ? "skill-effect" as const : "repeatability" as const;

  const leftResults = new Map(leftCompleteResults.map((result) => [trialKey(result), result]));
  const rightResults = new Map(rightCompleteResults.map((result) => [trialKey(result), result]));
  const keys = [...new Set([...leftResults.keys(), ...rightResults.keys()])].sort();
  const rows = keys.map((key) => {
    const left = leftResults.get(key);
    const right = rightResults.get(key);
    const leftScore = scoredValue(left);
    const rightScore = scoredValue(right);
    const change = leftScore === null || rightScore === null ? "missing" as const : rightScore > leftScore ? "improved" as const : rightScore < leftScore ? "regressed" as const : rightScore === 1 ? "stable-pass" as const : "stable-fail" as const;
    const source = left ?? right!;
    return { key, taskId: source.spec.task_id, profileId: source.spec.profile_id, condition: source.spec.condition_id, repeatIndex: source.spec.repeat_index, leftOutcome: left?.grade.outcome ?? null, rightOutcome: right?.grade.outcome ?? null, leftScore, rightScore, change };
  });
  const counts = { improved: 0, regressed: 0, stablePass: 0, stableFail: 0, missing: 0 };
  for (const row of rows) {
    if (row.change === "improved") counts.improved += 1;
    else if (row.change === "regressed") counts.regressed += 1;
    else if (row.change === "stable-pass") counts.stablePass += 1;
    else if (row.change === "stable-fail") counts.stableFail += 1;
    else counts.missing += 1;
  }
  const leftConditions = leftRun.report?.summary.by_condition ?? {};
  const rightConditions = rightRun.report?.summary.by_condition ?? {};
  const conditionDeltas = [...new Set([...Object.keys(leftConditions), ...Object.keys(rightConditions)])].sort().map((condition) => {
    const left = leftConditions[condition]?.success_rate ?? null;
    const right = rightConditions[condition]?.success_rate ?? null;
    return { condition, left, right, delta: left === null || right === null ? null : right - left };
  });
  const leftWallTimeMs = elapsed(leftRun.startedAt, leftRun.finishedAt);
  const rightWallTimeMs = elapsed(rightRun.startedAt, rightRun.finishedAt);
  return {
    comparability,
    reasons,
    skillChanged,
    leftSkill,
    rightSkill,
    counts,
    rows,
    conditionDeltas,
    leftWallTimeMs,
    rightWallTimeMs,
    wallTimeDeltaMs: leftWallTimeMs === null || rightWallTimeMs === null ? null : rightWallTimeMs - leftWallTimeMs,
  };
}
