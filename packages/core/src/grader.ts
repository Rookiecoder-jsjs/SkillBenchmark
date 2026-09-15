import { sha256 } from "./hash.ts";
import type { Artifact, Grade, Task, TrialSpec, ExecutionReceipt } from "../../contracts/src/types.ts";

const GRADER_DIGEST = sha256("exact-match-grader-v0.1");

export function gradeTrial(spec: TrialSpec, task: Task, receipt: ExecutionReceipt, artifact: Artifact | null): Grade {
  if (receipt.status === "errored" || receipt.status === "cancelled") return { schema_version: "0.1", trial_id: spec.trial_id, grader_digest: GRADER_DIGEST, outcome: "ungradable", metrics: { exact_match: 0 }, assertions: [{ name: "execution_completed", passed: false, detail: receipt.failure_reason ?? "infrastructure error" }], evidence_refs: [] };
  const output = artifact?.output ?? "";
  const passed = receipt.status === "completed" && output === task.expected_output;
  return { schema_version: "0.1", trial_id: spec.trial_id, grader_digest: GRADER_DIGEST, outcome: passed ? "pass" : "fail", metrics: { exact_match: passed ? 1 : 0 }, assertions: [{ name: "exact_output_match", passed, detail: passed ? "output exactly matches the hidden expected output" : `expected ${JSON.stringify(task.expected_output)}, received ${JSON.stringify(output)}` }], evidence_refs: artifact ? [artifact.output_sha256] : [] };
}
