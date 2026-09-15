import { readFile } from "node:fs/promises";
import type { SuiteDiagnostics, SuiteSnapshot, Task } from "../../contracts/src/types.ts";
import { sha256, stableJson } from "./hash.ts";

export async function loadSuite(path: string): Promise<SuiteSnapshot> {
  const raw = JSON.parse(await readFile(path, "utf8")) as { suite_id: string; label: string; tasks: Task[]; split_policy?: string; metric_policy?: string };
  if (!raw.suite_id || !Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error("suite must provide suite_id and at least one task");
  const diagnostics = validateTasks(raw.tasks);
  if (diagnostics.errors.length) throw new Error(diagnostics.errors.map((error) => `${error.code}: ${error.message}`).join("; "));
  const digest = sha256(stableJson({ suite_id: raw.suite_id, tasks: raw.tasks, split_policy: raw.split_policy ?? "source-group" }));
  return { schema_version: "0.1", suite_id: raw.suite_id, label: raw.label ?? raw.suite_id, digest, tasks: raw.tasks, split_policy: raw.split_policy ?? "source-group", metric_policy: raw.metric_policy ?? "exact-match" };
}

export function validateTasks(tasks: Task[]): SuiteDiagnostics {
  const errors: SuiteDiagnostics["errors"] = [];
  const warnings: SuiteDiagnostics["warnings"] = [];
  const byId = new Map<string, string[]>();
  const bySource = new Map<string, Set<string>>();
  for (const task of tasks) {
    const ids = byId.get(task.task_id) ?? [];
    ids.push(task.task_id);
    byId.set(task.task_id, ids);
    const splits = bySource.get(task.source_group) ?? new Set<string>();
    splits.add(task.split);
    bySource.set(task.source_group, splits);
    if (!task.prompt || typeof task.prompt !== "string") errors.push({ code: "invalid_prompt", message: `task ${task.task_id} has no prompt` });
    if (!task.expected_output || typeof task.expected_output !== "string") errors.push({ code: "invalid_expected_output", message: `task ${task.task_id} has no expected output` });
  }
  for (const [taskId, ids] of byId) if (ids.length > 1) errors.push({ code: "duplicate_task_id", message: `task id appears more than once: ${taskId}`, task_ids: ids });
  for (const [sourceGroup, splits] of bySource) if (splits.size > 1) errors.push({ code: "split_overlap", message: `source group ${sourceGroup} appears in multiple splits: ${[...splits].join(", ")}` });
  if (!tasks.some((task) => task.split === "validation")) warnings.push({ code: "missing_validation", message: "suite has no validation tasks" });
  return { errors, warnings };
}
