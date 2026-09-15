import { spawn } from "node:child_process";
import type { Grade } from "../../contracts/src/types.ts";

export interface ExternalGraderRequest {
  command: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
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

export function runExternalGrader(request: ExternalGraderRequest, input: ExternalGradeInput): Promise<Grade> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args ?? [], { cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      settled = true;
      reject(new Error(`grader timed out after ${request.timeout_ms ?? 30_000}ms`));
    }, request.timeout_ms ?? 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`grader exited with code ${code}: ${stderr.trim()}`));
      try { resolve(validateGrade(JSON.parse(stdout))); } catch (error) { reject(new Error(`invalid grader output: ${error instanceof Error ? error.message : String(error)}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
