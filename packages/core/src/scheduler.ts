import type { RunPlan, RunReport, SuiteSnapshot, TrialResult } from "../../contracts/src/types.ts";
import { gradeTrial } from "./grader.ts";
import { buildRunReport } from "./pipeline.ts";
import type { PublicTask } from "./mock-runner.ts";
import type { RunnerAdapter } from "./runner.ts";
import type { SqliteStore } from "./storage.ts";
import type { EnvironmentBackend } from "./environment.ts";

export interface AsyncRunOptions {
  skill_dir?: string;
  background_skill_dirs?: string[];
  load_method?: "explicit-file-read" | "prompt-inline" | "native";
}

/** Runs real adapters with bounded concurrency and retries only for infrastructure failures. */
export async function executePlanAsync(suite: SuiteSnapshot, plan: RunPlan, adapter: RunnerAdapter, environment: EnvironmentBackend, store?: SqliteStore, options: AsyncRunOptions = {}): Promise<RunReport> {
  if (adapter.supportedModes && !adapter.supportedModes.includes(plan.mode)) throw new Error(`adapter ${adapter.name} does not support ${plan.mode} mode`);
  store?.savePlan(plan);
  const taskById = new Map(suite.tasks.map((task) => [task.task_id, task]));
  const queue = [...plan.trials];
  const results: TrialResult[] = [];
  let attemptsUsed = 0;
  const take = (): typeof plan.trials[number] | undefined => queue.shift();
  const runOne = async (original: typeof plan.trials[number]): Promise<void> => {
    const task = taskById.get(original.task_id);
    if (!task) throw new Error(`task not found: ${original.task_id}`);
    const existing = store?.getResult(original.trial_id);
    if (existing) { results.push(existing); return; }
    let attempt = 0;
    const allEvents = [] as import("../../contracts/src/types.ts").TraceEvent[];
    while (true) {
      if (attemptsUsed >= plan.budget.max_attempts) {
        const skippedSpec = { ...original, attempt: Math.max(1, attempt) };
        const skippedReceipt = { trial_id: skippedSpec.trial_id, status: "cancelled" as const, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), artifact: null, failure_reason: `max_attempts=${plan.budget.max_attempts} exhausted`, failure_kind: "infrastructure" as const };
        const skipped = { spec: skippedSpec, receipt: skippedReceipt, events: allEvents, grade: gradeTrial(skippedSpec, task, skippedReceipt, null) };
        store?.saveResult(skipped);
        results.push(skipped);
        return;
      }
      attempt += 1;
      attemptsUsed += 1;
      const spec = { ...original, attempt };
      const publicTask: PublicTask = { task_id: task.task_id, prompt: task.prompt, mock_outputs: task.mock_outputs };
      let execution;
      let handle;
      try {
        handle = await environment.provision({ trialId: spec.trial_id, conditionId: spec.condition_id, publicInput: task.prompt, skillDir: options.skill_dir, backgroundSkillDirs: options.background_skill_dirs });
        execution = await adapter.execute(spec, publicTask, { environment: handle, model: plan.profiles.find((profile) => profile.profile_id === spec.profile_id)?.model ?? "unknown", timeout_ms: plan.budget.timeout_ms, load_method: options.load_method ?? plan.load_method, mode: plan.mode });
        await environment.collect(handle);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        execution = { events: [], receipt: { trial_id: spec.trial_id, status: "errored" as const, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), artifact: null, failure_reason: message, failure_kind: "infrastructure" as const } };
      } finally {
        if (handle) await environment.destroy(handle);
      }
      const offset = allEvents.length;
      for (const event of execution.events) allEvents.push({ ...event, seq: offset + event.seq, event_id: `${spec.trial_id}-evt-${offset + event.seq}` });
      const result: TrialResult = { spec, receipt: execution.receipt, events: allEvents, grade: gradeTrial(spec, task, execution.receipt, execution.receipt.artifact) };
      if (result.receipt.status === "errored" && result.receipt.failure_kind === "infrastructure" && attemptsUsed < plan.budget.max_attempts) continue;
      store?.saveResult(result);
      results.push(result);
      return;
    }
  };
  const worker = async (): Promise<void> => { while (true) { const next = take(); if (!next) return; await runOne(next); } };
  const workerCount = Math.max(1, Math.min(plan.budget.concurrency, plan.trials.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const order = new Map(plan.trials.map((trial, index) => [trial.trial_id, index]));
  results.sort((a, b) => (order.get(a.spec.trial_id) ?? 0) - (order.get(b.spec.trial_id) ?? 0));
  return buildRunReport(plan, results);
}
