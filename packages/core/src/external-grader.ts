import type { Grade } from "../../contracts/src/types.ts";
import { runSubprocess } from "./subprocess.ts";

export interface ExternalGraderRequest {
  command: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
  max_output_bytes?: number;
}

export interface ExternalGradeInput {
  schema_version: "0.1";
  trial_id: string;
  task: { task_id: string; public_input: string; expected_output: string };
  artifact: { output: string; output_sha256: string } | null;
}

function validateGrade(value: unknown): Grade {
  if (!value || typeof value !== "object") throw new Error("grader output is not an object");
  const grade = value as Partial<Grade>;
  if (grade.schema_version !== "0.1" || !grade.trial_id || !grade.grader_digest || !["pass", "fail", "ungradable"].includes(grade.outcome ?? "")) throw new Error("grader output does not satisfy the Grade contract");
  return grade as Grade;
}

export async function runExternalGrader(request: ExternalGraderRequest, input: ExternalGradeInput): Promise<Grade> {
  const result = await runSubprocess({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    input: JSON.stringify(input),
    timeout_ms: request.timeout_ms,
    max_output_bytes: request.max_output_bytes,
  });
  if (result.timedOut) throw new Error(`grader timed out after ${request.timeout_ms ?? 30_000}ms`);
  if (result.outputLimitExceeded) throw new Error(`grader output exceeded ${request.max_output_bytes ?? "the default"} bytes`);
  if (result.spawnError) throw new Error(`grader failed to start: ${result.spawnError}`);
  if (result.code !== 0) throw new Error(`grader exited with code ${result.code}: ${result.stderr.trim()}`);
  try { return validateGrade(JSON.parse(result.stdout)); } catch (error) { throw new Error(`invalid grader output: ${error instanceof Error ? error.message : String(error)}`); }
}
