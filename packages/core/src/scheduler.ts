import type { EnvironmentHandle, RunPlan, RunReport, SuiteSnapshot, Task, TraceEvent, TrialResult } from "../../contracts/src/types.ts";
import { gradeTrial } from "./grader.ts";
import { buildRunReport } from "./pipeline.ts";
import type { PublicTask } from "./mock-runner.ts";
import type { RunnerAdapter } from "./runner.ts";
import type { SqliteStore } from "./storage.ts";
import type { EnvironmentBackend } from "./environment.ts";

export interface AsyncRunOptions {
  skill_dir?: string;
  skill_dirs?: Partial<Record<RunPlan["conditions"][number], string>>;
  background_skill_dirs?: string[];
  load_method?: "explicit-file-read" | "prompt-inline" | "native";
  signal?: AbortSignal;
  on_progress?: (event: RunProgressEvent) => void;
}

export interface RunProgressEvent {
  type: "trial.running" | "trace.event" | "trial.finished";
  trial_id: string;
  timestamp: string;
  status?: TrialResult["receipt"]["status"];
  event?: TraceEvent;
}

const CLEANUP_TIMEOUT_MS = 5_000;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function cancelledResult(spec: RunPlan["trials"][number], task: Task, events: TraceEvent[], reason: string, attempt: number): TrialResult {
  const cancelledSpec = { ...spec, attempt: Math.max(1, attempt) };
  const event: TraceEvent = { schema_version: "0.1", event_id: `${cancelledSpec.trial_id}-evt-${events.length + 1}`, trial_id: cancelledSpec.trial_id, seq: events.length + 1, timestamp: new Date().toISOString(), producer: "adapter", kind: "trial.finished", data: { status: "cancelled", reason } };
  const receipt = { trial_id: cancelledSpec.trial_id, status: "cancelled" as const, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), artifact: null, failure_reason: reason, failure_kind: "cancelled" as const };
  return { spec: cancelledSpec, receipt, events: [...events, event], grade: gradeTrial(cancelledSpec, task, receipt, null) };
}

/** Runs real adapters with bounded concurrency and retries only for infrastructure failures. */
export async function executePlanAsync(suite: SuiteSnapshot, plan: RunPlan, adapter: RunnerAdapter, environment: EnvironmentBackend, store?: SqliteStore, options: AsyncRunOptions = {}): Promise<RunReport> {
  if (adapter.supportedModes && !adapter.supportedModes.includes(plan.mode)) throw new Error(`adapter ${adapter.name} does not support ${plan.mode} mode`);
  store?.savePlan(plan);
  const taskById = new Map(suite.tasks.map((task) => [task.task_id, task]));
  const queue = [...plan.trials];
  const results: TrialResult[] = [];
  let attemptsUsed = 0;
  const maxDurationMs = plan.budget.max_duration_ms ?? Math.max(60_000, plan.budget.timeout_ms * Math.max(1, plan.trials.length));
  const deadline = Date.now() + maxDurationMs;
  const remaining = (): number => deadline - Date.now();
  const progress = (event: Omit<RunProgressEvent, "timestamp">): void => options.on_progress?.({ ...event, timestamp: new Date().toISOString() });
  const take = (): typeof plan.trials[number] | undefined => queue.shift();
  const runOne = async (original: typeof plan.trials[number]): Promise<void> => {
    const task = taskById.get(original.task_id);
    if (!task) throw new Error(`task not found: ${original.task_id}`);
    const existing = store?.getResult(original.trial_id);
    if (existing) { results.push(existing); return; }
    let attempt = 0;
    const allEvents = [] as import("../../contracts/src/types.ts").TraceEvent[];
    let lastResult: TrialResult | null = null;
    while (!options.signal?.aborted && attemptsUsed < plan.budget.max_attempts && remaining() > 0) {
      attempt += 1;
      attemptsUsed += 1;
      const spec = { ...original, attempt };
      const publicTask: PublicTask = { task_id: task.task_id, prompt: task.prompt, mock_outputs: task.mock_outputs };
      let execution;
      let handle: EnvironmentHandle | undefined;
      let pendingProvision: Promise<EnvironmentHandle> | undefined;
      const operationTimeout = (): number => Math.max(1, Math.min(plan.budget.timeout_ms, remaining()));
      progress({ type: "trial.running", trial_id: spec.trial_id });
      try {
        pendingProvision = environment.provision({ trialId: spec.trial_id, conditionId: spec.condition_id, publicInput: task.prompt, skillDir: options.skill_dirs?.[spec.condition_id] ?? options.skill_dir, backgroundSkillDirs: options.background_skill_dirs });
        try {
          handle = await withTimeout(pendingProvision, operationTimeout(), "environment provision");
        } catch (error) {
          pendingProvision.then((lateHandle) => withTimeout(environment.destroy(lateHandle), CLEANUP_TIMEOUT_MS, "late environment cleanup").catch(() => undefined), () => undefined);
          throw error;
        }
        execution = await adapter.execute(spec, publicTask, { environment: handle, model: plan.profiles.find((profile) => profile.profile_id === spec.profile_id)?.model ?? "unknown", timeout_ms: operationTimeout(), load_method: options.load_method ?? plan.load_method, mode: plan.mode, signal: options.signal, on_event: (event) => progress({ type: "trace.event", trial_id: spec.trial_id, event }) });
        await withTimeout(environment.collect(handle), operationTimeout(), "environment collect");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        execution = { events: [], receipt: { trial_id: spec.trial_id, status: "errored" as const, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), artifact: null, failure_reason: message, failure_kind: "infrastructure" as const } };
      } finally {
        if (handle) {
          try { await withTimeout(environment.destroy(handle), CLEANUP_TIMEOUT_MS, "environment cleanup"); } catch { /* preserve the trial result; cleanup is bounded */ }
        }
      }
      const offset = allEvents.length;
      for (const event of execution.events) allEvents.push({ ...event, seq: offset + event.seq, event_id: `${spec.trial_id}-evt-${offset + event.seq}` });
      const result: TrialResult = { spec, receipt: execution.receipt, events: allEvents, grade: gradeTrial(spec, task, execution.receipt, execution.receipt.artifact) };
      lastResult = result;
      if (result.receipt.status === "errored" && result.receipt.failure_kind === "infrastructure" && attemptsUsed < plan.budget.max_attempts && remaining() > 0) continue;
      store?.saveResult(result);
      results.push(result);
      progress({ type: "trial.finished", trial_id: spec.trial_id, status: result.receipt.status });
      return;
    }
    const reason = options.signal?.aborted ? "run cancelled" : remaining() <= 0 ? `max_duration_ms=${maxDurationMs} exhausted` : `max_attempts=${plan.budget.max_attempts} exhausted`;
    const result = lastResult ?? cancelledResult(original, task, allEvents, reason, attempt);
    store?.saveResult(result);
    results.push(result);
    progress({ type: "trial.finished", trial_id: original.trial_id, status: result.receipt.status });
  };
  const worker = async (): Promise<void> => { while (queue.length > 0) { const next = take(); if (!next) return; await runOne(next); } };
  const workerCount = Math.max(1, Math.min(plan.budget.concurrency, plan.trials.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const order = new Map(plan.trials.map((trial, index) => [trial.trial_id, index]));
  results.sort((a, b) => (order.get(a.spec.trial_id) ?? 0) - (order.get(b.spec.trial_id) ?? 0));
  return buildRunReport(plan, results);
}
