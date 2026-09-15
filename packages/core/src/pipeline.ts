import type { RunPlan, RunReport, SuiteSnapshot, TrialResult } from "../../contracts/src/types.ts";
import { executeMock } from "./mock-runner.ts";
import { gradeTrial } from "./grader.ts";

export function executePlan(suite: SuiteSnapshot, plan: RunPlan): RunReport {
  const taskById = new Map(suite.tasks.map((task) => [task.task_id, task]));
  const results: TrialResult[] = [];
  for (const spec of plan.trials) {
    const task = taskById.get(spec.task_id);
    if (!task) throw new Error(`task not found: ${spec.task_id}`);
    const publicTask = { task_id: task.task_id, prompt: task.prompt, mock_outputs: task.mock_outputs };
    const execution = executeMock(spec, publicTask);
    results.push({ spec, receipt: execution.receipt, events: execution.events, grade: gradeTrial(spec, task, execution.receipt, execution.receipt.artifact) });
  }
  const byCondition: RunReport["summary"]["by_condition"] = {};
  for (const condition of plan.conditions) {
    const grades = results.filter((result) => result.spec.condition_id === condition).map((result) => result.grade);
    const scored = grades.filter((grade) => grade.outcome !== "ungradable");
    byCondition[condition] = { total: grades.length, passed: scored.filter((grade) => grade.outcome === "pass").length, success_rate: scored.length ? scored.filter((grade) => grade.outcome === "pass").length / scored.length : null };
  }
  const contrasts: RunReport["summary"]["contrasts"] = [];
  for (const [left, right] of [["none", "incumbent"], ["incumbent", "candidate"]] as const) {
    const pairs = new Map<string, Map<string, number>>();
    for (const result of results) {
      const key = `${result.spec.task_id}|${result.spec.profile_id}|${result.spec.repeat_index}`;
      const pair = pairs.get(key) ?? new Map<string, number>();
      if (result.grade.outcome !== "ungradable") pair.set(result.spec.condition_id, result.grade.metrics.exact_match);
      pairs.set(key, pair);
    }
    const differences: number[] = [];
    for (const pair of pairs.values()) if (pair.has(left) && pair.has(right)) differences.push((pair.get(right) as number) - (pair.get(left) as number));
    contrasts.push({ left, right, effect: differences.length ? differences.reduce((a, b) => a + b, 0) / differences.length : null, comparable_trials: differences.length });
  }
  return { schema_version: "0.1", run_id: plan.run_id, plan, results, summary: { by_condition: byCondition, contrasts } };
}

export function renderMarkdown(report: RunReport): string {
  const lines = [`# SkillBenchmark 运行报告`, ``, `- Run: \`${report.run_id}\``, `- Suite: \`${report.plan.suite_id}\``, `- Fingerprint: \`${report.plan.fingerprint}\``, ``, `## 条件汇总`, ``, `| 条件 | Trial 数 | 通过数 | 成功率 |`, `| --- | ---: | ---: | ---: |`];
  for (const [condition, summary] of Object.entries(report.summary.by_condition)) lines.push(`| ${condition} | ${summary.total} | ${summary.passed} | ${summary.success_rate === null ? "unknown" : `${(summary.success_rate * 100).toFixed(1)}%`} |`);
  lines.push(``, `## 对照`, ``, `| 对照 | 增益（右 − 左） | 可比 Trial |`, `| --- | ---: | ---: |`);
  for (const contrast of report.summary.contrasts) lines.push(`| ${contrast.right} − ${contrast.left} | ${contrast.effect === null ? "unknown" : contrast.effect.toFixed(3)} | ${contrast.comparable_trials} |`);
  lines.push(``, `## 逐题结果`, ``, `| Task | 条件 | 重复 | 状态 | 结果 |`, `| --- | --- | ---: | --- | --- |`);
  for (const result of report.results) lines.push(`| ${result.spec.task_id} | ${result.spec.condition_id} | ${result.spec.repeat_index} | ${result.receipt.status} | ${result.grade.outcome} |`);
  return `${lines.join("\n")}\n`;
}
