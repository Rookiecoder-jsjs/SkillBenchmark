import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import type { RunReport, TrialStatus } from "../../../packages/contracts/src/types.ts";
import { LocalEnvironmentBackend } from "../../../packages/core/src/environment.ts";
import { createRunPlan } from "../../../packages/core/src/plan.ts";
import { CodexAdapter, ClaudeCodeAdapter, type RunnerAdapter } from "../../../packages/core/src/runner.ts";
import { executePlanAsync, type RunProgressEvent } from "../../../packages/core/src/scheduler.ts";
import { SqliteStore, writeRunArtifacts } from "../../../packages/core/src/storage.ts";
import { attachStatistics } from "../../../packages/core/src/statistics.ts";
import type { WorkspacePlanStore } from "./plan-store.ts";
import type { WorkspaceSkillStore } from "./skill-store.ts";
import type { WorkspaceSuiteStore } from "./suite-store.ts";

export type WorkbenchRunStatus = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
export interface WorkbenchRun {
  runId: string;
  planId: string;
  name: string;
  status: WorkbenchRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  trialCount: number;
  completedTrials: number;
  trialStatuses: Record<string, "queued" | "running" | TrialStatus>;
  events: RunProgressEvent[];
  report: RunReport | null;
  error: string | null;
}
export type WorkbenchRunSummary = Omit<WorkbenchRun, "events" | "report"> & { events: RunProgressEvent[] };

interface ActiveRun { controller: AbortController; promise: Promise<void> }
const MAX_LIVE_EVENTS = 1_000;

export class WorkspaceRunStore {
  readonly workspaceRoot: string;
  readonly db: DatabaseSync;
  readonly planStore: WorkspacePlanStore;
  readonly suiteStore: WorkspaceSuiteStore;
  readonly skillStore: WorkspaceSkillStore;
  readonly active = new Map<string, ActiveRun>();
  readonly adapterFactory: (id: string, executablePath: string) => RunnerAdapter;

  constructor(workspaceRoot: string, dependencies: { planStore: WorkspacePlanStore; suiteStore: WorkspaceSuiteStore; skillStore: WorkspaceSkillStore; adapterFactory?: (id: string, executablePath: string) => RunnerAdapter }) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.planStore = dependencies.planStore;
    this.suiteStore = dependencies.suiteStore;
    this.skillStore = dependencies.skillStore;
    this.adapterFactory = dependencies.adapterFactory ?? ((id, executablePath) => id === "codex" ? new CodexAdapter(executablePath) : id === "claude-code" ? new ClaudeCodeAdapter(executablePath) : (() => { throw new Error(`Unsupported Agent: ${id}`); })());
    const stateRoot = join(this.workspaceRoot, ".skillbenchmark");
    mkdirSync(stateRoot, { recursive: true });
    this.db = new DatabaseSync(join(stateRoot, "metadata.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workspace_runs (
        run_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_json TEXT NOT NULL
      );
    `);
    const interrupted = this.db.prepare("SELECT run_json FROM workspace_runs WHERE status IN ('queued', 'running', 'cancelling')").all() as unknown as Array<{ run_json: string }>;
    for (const row of interrupted) {
      const run = JSON.parse(row.run_json) as WorkbenchRun;
      run.status = "failed";
      run.finishedAt = new Date().toISOString();
      run.error = "Local service stopped before the run finished";
      this.persist(run);
    }
  }

  private persist(run: WorkbenchRun): void {
    this.db.prepare("INSERT OR REPLACE INTO workspace_runs(run_id, plan_id, status, created_at, run_json) VALUES (?, ?, ?, ?, ?)").run(run.runId, run.planId, run.status, run.createdAt, JSON.stringify(run));
  }

  private read(runId: string): WorkbenchRun {
    const row = this.db.prepare("SELECT run_json FROM workspace_runs WHERE run_id = ?").get(runId) as { run_json: string } | undefined;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return JSON.parse(row.run_json) as WorkbenchRun;
  }

  listRuns(): WorkbenchRunSummary[] {
    const rows = this.db.prepare("SELECT run_json FROM workspace_runs ORDER BY created_at DESC LIMIT 50").all() as unknown as Array<{ run_json: string }>;
    return rows.map((row) => {
      const { report: _report, ...run } = JSON.parse(row.run_json) as WorkbenchRun;
      return { ...run, events: run.events.slice(-100) };
    });
  }

  getRun(runId: string): WorkbenchRun { return this.read(runId); }

  start(planId: string): WorkbenchRun {
    if (this.active.size > 0) throw new Error("Another run is active in this Workspace; cancel or wait for it before starting a new run");
    const frozen = this.planStore.getPlan(planId);
    const runId = `run-${randomUUID()}`;
    const trialStatuses = Object.fromEntries(frozen.corePlan.trials.map((trial) => [trial.trial_id.replace(frozen.corePlan.run_id, runId), "queued" as const]));
    const run: WorkbenchRun = { runId, planId, name: frozen.name, status: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, trialCount: frozen.corePlan.trials.length, completedTrials: 0, trialStatuses, events: [], report: null, error: null };
    this.persist(run);
    const controller = new AbortController();
    const promise = this.execute(runId, controller).finally(() => this.active.delete(runId));
    this.active.set(runId, { controller, promise });
    return run;
  }

  private async execute(runId: string, controller: AbortController): Promise<void> {
    const run = this.read(runId);
    const frozen = this.planStore.getPlan(run.planId);
    const suite = this.suiteStore.getVersion(frozen.suite.versionId);
    const runRoot = join(this.workspaceRoot, ".skillbenchmark", "runs", runId);
    const skillRoot = join(runRoot, "skills", "candidate");
    const store = new SqliteStore(join(runRoot, "metadata.sqlite"), join(runRoot, "objects"));
    try {
      await this.skillStore.materializeVersion(frozen.bindings.candidate!.versionId, skillRoot);
      const plan = createRunPlan(suite.snapshot, { runId, conditions: frozen.corePlan.conditions, repeats: frozen.corePlan.repeats, profiles: frozen.corePlan.profiles, budget: frozen.corePlan.budget, mode: frozen.corePlan.mode, load_method: frozen.corePlan.load_method });
      run.status = controller.signal.aborted ? "cancelling" : "running";
      run.startedAt = new Date().toISOString();
      run.trialStatuses = Object.fromEntries(plan.trials.map((trial) => [trial.trial_id, "queued" as const]));
      this.persist(run);
      const adapter = this.adapterFactory(frozen.agent.id, frozen.agent.executablePath);
      const report = attachStatistics(await executePlanAsync(suite.snapshot, plan, adapter, new LocalEnvironmentBackend(join(runRoot, "work")), store, {
        skill_dirs: { candidate: skillRoot },
        signal: controller.signal,
        on_progress: (event) => {
          if (controller.signal.aborted) run.status = "cancelling";
          run.events.push(event);
          if (run.events.length > MAX_LIVE_EVENTS) run.events.splice(0, run.events.length - MAX_LIVE_EVENTS);
          if (event.type === "trial.running") run.trialStatuses[event.trial_id] = "running";
          if (event.type === "trial.finished" && event.status) {
            run.trialStatuses[event.trial_id] = event.status;
            run.completedTrials = Object.values(run.trialStatuses).filter((status) => !["queued", "running"].includes(status)).length;
          }
          this.persist(run);
        },
      }));
      store.saveReport(report);
      await writeRunArtifacts(runRoot, plan, report);
      run.report = report;
      run.status = controller.signal.aborted ? "cancelled" : "completed";
      run.finishedAt = new Date().toISOString();
      this.persist(run);
    } catch (error) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.finishedAt = new Date().toISOString();
      run.error = error instanceof Error ? error.message : String(error);
      this.persist(run);
    } finally { store.close(); }
  }

  cancel(runId: string): WorkbenchRun {
    const run = this.read(runId);
    const active = this.active.get(runId);
    if (!active || !["queued", "running"].includes(run.status)) return run;
    run.status = "cancelling";
    this.persist(run);
    active.controller.abort();
    return run;
  }

  async close(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    this.db.close();
  }
}
