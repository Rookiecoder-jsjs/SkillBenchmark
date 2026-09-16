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
  spec: { trial_id: string; task_id: string; condition_id: string; repeat_index: number };
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
  const wallTimeMs = elapsed(run.startedAt, run.finishedAt ?? (run.startedAt ? new Date(now).toISOString() : null));
  const trials = (report?.results ?? []).map((result) => ({
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
  const reportEvents = (report?.results ?? []).flatMap((result) => result.events);
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
