import { readFile } from "node:fs/promises";
import type { SuiteSnapshot, Task } from "../../contracts/src/types.ts";
import { sha256, stableJson } from "./hash.ts";

export async function loadSuite(path: string): Promise<SuiteSnapshot> {
  const raw = JSON.parse(await readFile(path, "utf8")) as { suite_id: string; label: string; tasks: Task[]; split_policy?: string; metric_policy?: string };
  if (!raw.suite_id || !Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error("suite must provide suite_id and at least one task");
  const digest = sha256(stableJson({ suite_id: raw.suite_id, tasks: raw.tasks, split_policy: raw.split_policy ?? "source-group" }));
  return { schema_version: "0.1", suite_id: raw.suite_id, label: raw.label ?? raw.suite_id, digest, tasks: raw.tasks, split_policy: raw.split_policy ?? "source-group", metric_policy: raw.metric_policy ?? "exact-match" };
}
