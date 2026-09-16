import { readFile } from "node:fs/promises";
import type { CapabilityReport, EnvironmentHandle, EvaluationMode, ExecutionReceipt, LoadMethod, TraceEvent, TrialSpec } from "../../contracts/src/types.ts";
import type { PublicTask, MockExecution } from "./mock-runner.ts";
import { sha256 } from "./hash.ts";
import { runSubprocess } from "./subprocess.ts";

export interface RunnerContext {
  environment: EnvironmentHandle;
  model: string;
  timeout_ms: number;
  max_output_bytes?: number;
  load_method: LoadMethod;
  mode: EvaluationMode;
  signal?: AbortSignal;
  on_event?: (event: TraceEvent) => void;
}

export interface RunnerAdapter {
  readonly name: string;
  readonly supportedModes?: EvaluationMode[];
  probe(): Promise<CapabilityReport>;
  execute(spec: TrialSpec, task: PublicTask, context: RunnerContext): Promise<MockExecution>;
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["result", "text", "output"]) if (typeof record[key] === "string") return record[key] as string;
  const item = record.item;
  if (item && typeof item === "object") {
    const nested = textFrom(item);
    if (nested) return nested;
  }
  const message = record.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) return content.map((part) => textFrom(part) ?? "").join("") || null;
  }
  return null;
}

export class SubprocessRunnerAdapter implements RunnerAdapter {
  readonly name: string;
  readonly supportedModes: EvaluationMode[] = ["controlled"];
  readonly command: string;
  readonly platform: string;
  readonly argsBuilder: (prompt: string, model: string, context?: RunnerContext) => string[];
  constructor(name: string, command: string, platform: string, argsBuilder: (prompt: string, model: string, context?: RunnerContext) => string[]) { this.name = name; this.command = command; this.platform = platform; this.argsBuilder = argsBuilder; }

  async probe(): Promise<CapabilityReport> {
    const result = await runSubprocess({ command: this.command, args: ["--version"], cwd: process.cwd(), timeout_ms: 10_000 });
    const version = result.stdout.trim().split("\n")[0] || null;
    return { adapter: this.name, platform: this.platform, status: result.code === 0 ? "exploratory" : "unsupported", version, capabilities: result.code === 0 ? ["non-interactive", "structured-output", ...this.supportedModes] : [], evidence: result.code === 0 ? [result.stdout.trim()] : [result.stderr.trim()] };
  }

  async execute(spec: TrialSpec, task: PublicTask, context: RunnerContext): Promise<MockExecution> {
    const started = new Date().toISOString();
    const events: TraceEvent[] = [];
    const event = (seq: number, kind: string, data: Record<string, unknown>, producer: TraceEvent["producer"] = "adapter"): TraceEvent => ({ schema_version: "0.1", event_id: `${spec.trial_id}-evt-${seq}`, trial_id: spec.trial_id, seq, timestamp: new Date().toISOString(), producer, kind, data });
    const emit = (value: TraceEvent): void => { events.push(value); context.on_event?.(value); };
    let skillInstruction = "";
    if (context.load_method === "explicit-file-read" && context.environment.skill_path) skillInstruction = `\nRead the Skill instructions at ${context.environment.skill_path} before answering.`;
    if (context.load_method === "prompt-inline" && context.environment.skill_path) skillInstruction = `\nSkill instructions:\n${await readFile(`${context.environment.skill_path}/SKILL.md`, "utf8").catch(() => "")}`;
    const prompt = `${task.prompt}${skillInstruction}`;
    emit(event(1, "trial.started", { condition_id: spec.condition_id, attempt: spec.attempt }));
    emit(event(2, "skill.provisioned", { condition_id: spec.condition_id, method: context.load_method, exposure: context.environment.skill_path ? "available" : "absent", background_skill_count: context.environment.background_skill_paths?.length ?? 0, load_observation: context.mode === "native" ? "platform-managed" : "unknown" }));
    let output = "";
    let seq = 3;
    let stdoutBuffer = "";
    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const candidate = textFrom(parsed);
        if (candidate !== null) output = candidate;
        emit(event(seq++, `platform.${typeof parsed.type === "string" ? parsed.type : "event"}`, { raw: JSON.stringify(parsed).slice(0, 4096) }, "platform"));
      } catch { output = trimmed; }
    };
    const result = await runSubprocess({
      command: this.command,
      args: this.argsBuilder(prompt, context.model, context),
      cwd: context.environment.workdir,
      timeout_ms: context.timeout_ms,
      max_output_bytes: context.max_output_bytes,
      signal: context.signal,
      on_stdout: (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      },
      env: {
        SKILLBENCHMARK_INPUT: context.environment.public_input_path,
        SKILLBENCHMARK_SKILL_PATH: context.environment.skill_path ?? "",
        SKILLBENCHMARK_BACKGROUND_SKILLS: (context.environment.background_skill_paths ?? []).join(process.platform === "win32" ? ";" : ":"),
        SKILLBENCHMARK_ATTEMPT: String(spec.attempt),
        SKILLBENCHMARK_TRIAL_ID: spec.trial_id,
      },
    });
    consumeLine(stdoutBuffer);
    if (result.cancelled) {
      emit(event(seq, "trial.finished", { status: "cancelled", reason: "run cancelled" }));
      return { events, receipt: { trial_id: spec.trial_id, status: "cancelled", started_at: started, finished_at: new Date().toISOString(), artifact: null, failure_reason: "run cancelled", failure_kind: "cancelled" } };
    }
    if (result.outputLimitExceeded) {
      emit(event(seq, "trial.finished", { status: "errored", reason: "process output limit" }));
      return { events, receipt: { trial_id: spec.trial_id, status: "errored", started_at: started, finished_at: new Date().toISOString(), artifact: null, failure_reason: "process output limit exceeded", failure_kind: "task" } };
    }
    if (result.timedOut) {
      emit(event(seq, "trial.finished", { status: "timed_out", reason: "process timeout" }));
      return { events, receipt: { trial_id: spec.trial_id, status: "timed_out", started_at: started, finished_at: new Date().toISOString(), artifact: null, failure_reason: "process timeout", failure_kind: "task" } };
    }
    if (result.spawnError) {
      emit(event(seq, "trial.finished", { status: "errored", reason: result.spawnError }));
      return { events, receipt: { trial_id: spec.trial_id, status: "errored", started_at: started, finished_at: new Date().toISOString(), artifact: null, failure_reason: result.spawnError, failure_kind: "infrastructure" } };
    }
    if (result.code !== 0) {
      emit(event(seq, "trial.finished", { status: "errored", code: result.code, signal: result.signal, stderr: result.stderr.slice(0, 4096) }));
      const infrastructure = result.stderr.trim().startsWith("INFRASTRUCTURE");
      return { events, receipt: { trial_id: spec.trial_id, status: "errored", started_at: started, finished_at: new Date().toISOString(), artifact: null, failure_reason: result.signal ? `runner terminated by ${result.signal}` : `runner exited with code ${result.code}`, failure_kind: infrastructure ? "infrastructure" : "task" } };
    }
    emit(event(seq++, "message.final", { output_bytes: Buffer.byteLength(output) }));
    emit(event(seq, "trial.finished", { status: "completed" }));
    return { events, receipt: { trial_id: spec.trial_id, status: "completed", started_at: started, finished_at: new Date().toISOString(), artifact: { trial_id: spec.trial_id, output, output_sha256: sha256(output) }, failure_reason: null, failure_kind: null } };
  }

}

export class CodexAdapter extends SubprocessRunnerAdapter {
  constructor(command = "codex") { super("codex", command, "codex", (prompt, model) => ["exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", ...(model && model !== "default" ? ["--model", model] : []), prompt]); this.supportedModes.splice(0, this.supportedModes.length, "controlled", "coexistence"); }
}

export class ClaudeCodeAdapter extends SubprocessRunnerAdapter {
  constructor(command = "claude") { super("claude-code", command, "claude-code", (prompt, model, context) => ["-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...(model && model !== "default" ? ["--model", model] : []), ...(context?.mode === "native" && context.environment.skill_path ? ["--plugin-dir", context.environment.skill_path] : [])]); this.supportedModes.splice(0, this.supportedModes.length, "controlled", "native", "coexistence"); }
}
