import { sha256 } from "./hash.ts";
import type { Artifact, ExecutionReceipt, Task, TraceEvent, TrialSpec } from "../../contracts/src/types.ts";

const now = () => new Date().toISOString();

export interface MockExecution {
  receipt: ExecutionReceipt;
  events: TraceEvent[];
}

/** Runner only receives the public projection; expected_output stays in the grader process. */
export type PublicTask = Pick<Task, "task_id" | "prompt" | "mock_outputs">;

export function executeMock(spec: TrialSpec, task: PublicTask): MockExecution {
  const started = now();
  const configured = task.mock_outputs[spec.condition_id] ?? task.mock_outputs.none ?? "";
  const events: TraceEvent[] = [];
  const event = (seq: number, kind: string, data: Record<string, unknown>): TraceEvent => ({ schema_version: "0.1", event_id: `${spec.trial_id}-evt-${seq}`, trial_id: spec.trial_id, seq, timestamp: now(), producer: "adapter", kind, data });
  events.push(event(1, "trial.started", { condition_id: spec.condition_id, attempt: spec.attempt }));
  events.push(event(2, "skill.provisioned", { condition_id: spec.condition_id, method: "mock", exposure: spec.condition_id === "none" ? "absent" : "available", load_observation: "unverified" }));
  if (configured === "__INFRA_ERROR__") {
    events.push(event(3, "trial.finished", { status: "errored", reason: "mock infrastructure failure" }));
    return { events, receipt: { trial_id: spec.trial_id, status: "errored", started_at: started, finished_at: now(), artifact: null, failure_reason: "mock infrastructure failure" } };
  }
  if (configured === "__TIMEOUT__") {
    events.push(event(3, "trial.finished", { status: "timed_out", reason: "mock timeout" }));
    return { events, receipt: { trial_id: spec.trial_id, status: "timed_out", started_at: started, finished_at: now(), artifact: null, failure_reason: "mock timeout" } };
  }
  const artifact: Artifact = { trial_id: spec.trial_id, output: configured, output_sha256: sha256(configured) };
  events.push(event(3, "message.final", { output_ref: artifact.output_sha256, output_bytes: Buffer.byteLength(configured) }));
  events.push(event(4, "artifact.created", { digest: artifact.output_sha256 }));
  events.push(event(5, "trial.finished", { status: "completed" }));
  return { events, receipt: { trial_id: spec.trial_id, status: "completed", started_at: started, finished_at: now(), artifact, failure_reason: null } };
}
