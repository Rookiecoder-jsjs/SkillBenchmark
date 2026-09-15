import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import type { RunPlan, RunReport, TrialResult } from "../../contracts/src/types.ts";
import { sha256 } from "./hash.ts";
import { renderMarkdown } from "./pipeline.ts";

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS objects (digest TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, storage_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, plan_digest TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trials (trial_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, condition_id TEXT NOT NULL, repeat_index INTEGER NOT NULL, result_json TEXT, UNIQUE(run_id, task_id, condition_id, repeat_index));
      CREATE TABLE IF NOT EXISTS events (trial_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(trial_id, seq));
      CREATE TABLE IF NOT EXISTS grades (trial_id TEXT PRIMARY KEY, grader_digest TEXT NOT NULL, grade_json TEXT NOT NULL);
    `);
  }

  savePlan(plan: RunPlan): void {
    const planJson = JSON.stringify(plan);
    const planDigest = sha256(planJson);
    const existing = this.db.prepare("SELECT plan_digest FROM runs WHERE run_id = ?").get(plan.run_id) as { plan_digest?: string } | undefined;
    if (existing?.plan_digest && existing.plan_digest !== planDigest) throw new Error(`run id already exists with a different plan: ${plan.run_id}`);
    this.db.prepare("INSERT OR IGNORE INTO runs(run_id, plan_digest, plan_json, created_at) VALUES (?, ?, ?, ?)").run(plan.run_id, planDigest, planJson, new Date().toISOString());
    const statement = this.db.prepare("INSERT OR IGNORE INTO trials(trial_id, run_id, task_id, condition_id, repeat_index) VALUES (?, ?, ?, ?, ?)");
    for (const trial of plan.trials) statement.run(trial.trial_id, trial.run_id, trial.task_id, trial.condition_id, trial.repeat_index);
  }

  saveResult(result: TrialResult): void {
    const resultJson = JSON.stringify(result);
    this.db.prepare("UPDATE trials SET result_json = ? WHERE trial_id = ?").run(resultJson, result.spec.trial_id);
    const eventStatement = this.db.prepare("INSERT OR IGNORE INTO events(trial_id, seq, event_json) VALUES (?, ?, ?)");
    for (const event of result.events) eventStatement.run(event.trial_id, event.seq, JSON.stringify(event));
    this.db.prepare("INSERT OR REPLACE INTO grades(trial_id, grader_digest, grade_json) VALUES (?, ?, ?)").run(result.grade.trial_id, result.grade.grader_digest, JSON.stringify(result.grade));
    if (result.receipt.artifact) this.db.prepare("INSERT OR IGNORE INTO objects(digest, type, size, storage_ref) VALUES (?, ?, ?, ?)").run(result.receipt.artifact.output_sha256, "artifact", Buffer.byteLength(result.receipt.artifact.output), `inline:${result.spec.trial_id}`);
  }

  getResult(trialId: string): TrialResult | null {
    const row = this.db.prepare("SELECT result_json FROM trials WHERE trial_id = ?").get(trialId) as { result_json?: string } | undefined;
    return row?.result_json ? JSON.parse(row.result_json) as TrialResult : null;
  }

  countEvents(trialId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE trial_id = ?").get(trialId) as { count: number }).count);
  }

  close(): void { this.db.close(); }
}

export async function writeRunArtifacts(outputDir: string, plan: RunPlan, report?: RunReport): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  if (report) {
    await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(outputDir, "report.md"), renderMarkdown(report));
    await writeFile(join(outputDir, "report.html"), renderHtml(report));
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderHtml(report: RunReport): string {
  const rows = Object.entries(report.summary.by_condition).map(([condition, summary]) => `<tr><td>${escapeHtml(condition)}</td><td>${summary.total}</td><td>${summary.passed}</td><td>${summary.success_rate === null ? "unknown" : `${(summary.success_rate * 100).toFixed(1)}%`}</td></tr>`).join("");
  const trialRows = report.results.map((result) => `<tr><td>${escapeHtml(result.spec.task_id)}</td><td>${escapeHtml(result.spec.condition_id)}</td><td>${result.spec.repeat_index}</td><td>${escapeHtml(result.receipt.status)}</td><td>${escapeHtml(result.grade.outcome)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SkillBenchmark ${escapeHtml(report.run_id)}</title><style>body{font:15px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #ccc;padding:.4rem .7rem;text-align:left}code{word-break:break-all}</style><h1>SkillBenchmark 运行报告</h1><p>Run: <code>${escapeHtml(report.run_id)}</code><br>Suite: <code>${escapeHtml(report.plan.suite_id)}</code></p><h2>条件汇总</h2><table><thead><tr><th>条件</th><th>Trial 数</th><th>通过数</th><th>成功率</th></tr></thead><tbody>${rows}</tbody></table><h2>逐题结果</h2><table><thead><tr><th>Task</th><th>条件</th><th>重复</th><th>状态</th><th>结果</th></tr></thead><tbody>${trialRows}</tbody></table></html>\n`;
}
