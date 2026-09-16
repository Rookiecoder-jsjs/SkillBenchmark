import { readFile } from "node:fs/promises";
import type { SuiteDiagnostics, SuiteSnapshot, Task } from "../../contracts/src/types.ts";
import { sha256, stableJson } from "./hash.ts";

export async function loadSuite(path: string): Promise<SuiteSnapshot> {
  return parseSuite(JSON.parse(await readFile(path, "utf8")));
}

export function parseSuite(value: unknown): SuiteSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("suite must be a JSON object");
  const raw = value as { suite_id?: unknown; label?: unknown; tasks?: unknown; split_policy?: unknown; metric_policy?: unknown };
  if (!raw.suite_id || !Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error("suite must provide suite_id and at least one task");
  if (typeof raw.suite_id !== "string" || raw.suite_id.length > 160) throw new Error("suite_id must be a string of at most 160 characters");
  if (!/^[A-Za-z0-9._-]+$/.test(raw.suite_id)) throw new Error("suite_id may only contain letters, numbers, dots, underscores and hyphens");
  if (!raw.tasks.every((task) => task && typeof task === "object" && !Array.isArray(task))) throw new Error("suite tasks must be JSON objects");
  const tasks = raw.tasks as Task[];
  const diagnostics = validateTasks(tasks);
  if (diagnostics.errors.length) throw new Error(diagnostics.errors.map((error) => `${error.code}: ${error.message}`).join("; "));
  const splitPolicy = typeof raw.split_policy === "string" ? raw.split_policy : "source-group";
  const metricPolicy = typeof raw.metric_policy === "string" ? raw.metric_policy : "exact-match";
  const digest = sha256(stableJson({ suite_id: raw.suite_id, tasks, split_policy: splitPolicy }));
  return { schema_version: "0.1", suite_id: raw.suite_id, label: typeof raw.label === "string" && raw.label ? raw.label : raw.suite_id, digest, tasks, split_policy: splitPolicy, metric_policy: metricPolicy };
}

export function validateTasks(tasks: Task[]): SuiteDiagnostics {
  const errors: SuiteDiagnostics["errors"] = [];
  const warnings: SuiteDiagnostics["warnings"] = [];
  const byId = new Map<string, string[]>();
  const bySource = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!task.task_id || typeof task.task_id !== "string") errors.push({ code: "invalid_task_id", message: "task has no task_id" });
    if (!task.source_group || typeof task.source_group !== "string") errors.push({ code: "invalid_source_group", message: `task ${task.task_id ?? "unknown"} has no source_group` });
    if (!(["train", "validation", "test"] as unknown[]).includes(task.split)) errors.push({ code: "invalid_split", message: `task ${task.task_id ?? "unknown"} has invalid split` });
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
