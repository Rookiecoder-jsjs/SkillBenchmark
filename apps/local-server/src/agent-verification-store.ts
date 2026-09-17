import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { LocalEnvironmentBackend } from "../../../packages/core/src/environment.ts";
import { ClaudeCodeAdapter, CodexAdapter, type RunnerAdapter } from "../../../packages/core/src/runner.ts";
import type { AgentDiscovery, AgentId } from "./discovery.ts";
import { buildAgentCapabilityMatrix, type AgentCapabilityEvidence } from "./agent-capabilities.ts";

export type AgentVerificationStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type AgentVerificationKind = "connection" | "consistency";
export type AgentVerificationStepStatus = "pending" | "running" | "passed" | "failed" | "not-reported" | "cancelled";

export interface AgentVerificationStep {
  id: "receipt" | "tool-events" | "timeout-control" | "cancellation-control";
  status: AgentVerificationStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string;
}

export interface AgentVerification {
  verificationId: string;
  agentId: AgentId;
  kind: AgentVerificationKind;
  status: AgentVerificationStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requestedModel: string;
  authentication: "unknown" | "ready" | "required" | "failed";
  evaluationSupport: "exploratory" | "verified";
  userAcknowledgedModelUsage: boolean;
  checks: { exactOutput: boolean; structuredResult: boolean; isolatedWorkspace: boolean; toolEvents: boolean; timeoutControl: boolean; cancellationControl: boolean };
  steps: AgentVerificationStep[];
  receipt: { requested_model: string; reported_model: string | null; session_id: string | null; input_tokens: number | null; output_tokens: number | null; estimated_cost: number | null } | null;
  capabilityMatrix: AgentCapabilityEvidence[];
  error: string | null;
}

interface ActiveVerification { controller: AbortController; promise: Promise<void> }
const EXPECTED_OUTPUT = "SKILLBENCHMARK_CONNECTION_OK";

function safeModel(model: string): string {
  const value = model.trim() || "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) throw new Error("model must be 'default' or a valid model identifier");
  return value;
}

export class WorkspaceAgentVerificationStore {
  readonly workspaceRoot: string;
  readonly db: DatabaseSync;
  readonly adapterFactory: (agent: AgentDiscovery) => RunnerAdapter;
  readonly timeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly cancelAfterMs: number;
  readonly active = new Map<string, ActiveVerification>();
  readonly activeByAgent = new Map<AgentId, string>();

  constructor(workspaceRoot: string, options: { adapterFactory?: (agent: AgentDiscovery) => RunnerAdapter; timeoutMs?: number; probeTimeoutMs?: number; cancelAfterMs?: number } = {}) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.adapterFactory = options.adapterFactory ?? ((agent) => agent.id === "codex" ? new CodexAdapter(agent.executablePath!) : new ClaudeCodeAdapter(agent.executablePath!));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 750;
    this.cancelAfterMs = options.cancelAfterMs ?? 250;
    const stateRoot = join(this.workspaceRoot, ".skillbenchmark");
    mkdirSync(stateRoot, { recursive: true });
    this.db = new DatabaseSync(join(stateRoot, "metadata.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_verifications (
        verification_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        verification_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_verifications_agent_created ON agent_verifications(agent_id, created_at DESC);
    `);
    const interrupted = this.db.prepare("SELECT verification_json FROM agent_verifications WHERE status IN ('queued', 'running', 'cancelling')").all() as unknown as Array<{ verification_json: string }>;
    for (const row of interrupted) {
      const verification = this.normalize(JSON.parse(row.verification_json) as AgentVerification);
      verification.status = "failed";
      verification.finishedAt = new Date().toISOString();
      verification.authentication = "failed";
      verification.error = "Local service stopped before connection verification finished";
      this.persist(verification);
    }
  }

  private normalize(verification: AgentVerification): AgentVerification {
    verification.kind ??= "connection";
    verification.userAcknowledgedModelUsage ??= false;
    verification.steps ??= [];
    verification.checks.timeoutControl ??= false;
    verification.checks.cancellationControl ??= false;
    return verification;
  }

  private persist(verification: AgentVerification): void {
    this.db.prepare("INSERT OR REPLACE INTO agent_verifications(verification_id, agent_id, status, created_at, verification_json) VALUES (?, ?, ?, ?, ?)").run(verification.verificationId, verification.agentId, verification.status, verification.createdAt, JSON.stringify(verification));
  }

  get(verificationId: string): AgentVerification {
    const row = this.db.prepare("SELECT verification_json FROM agent_verifications WHERE verification_id = ?").get(verificationId) as { verification_json: string } | undefined;
    if (!row) throw new Error(`Agent verification not found: ${verificationId}`);
    return this.normalize(JSON.parse(row.verification_json) as AgentVerification);
  }

  latest(agentId: AgentId): AgentVerification | null {
    const row = this.db.prepare("SELECT verification_json FROM agent_verifications WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1").get(agentId) as { verification_json: string } | undefined;
    return row ? this.normalize(JSON.parse(row.verification_json) as AgentVerification) : null;
  }

  latestConsistency(agentId: AgentId): AgentVerification | null {
    const rows = this.db.prepare("SELECT verification_json FROM agent_verifications WHERE agent_id = ? ORDER BY created_at DESC").all(agentId) as unknown as Array<{ verification_json: string }>;
    for (const row of rows) {
      const verification = this.normalize(JSON.parse(row.verification_json) as AgentVerification);
      if (verification.kind === "consistency") return verification;
    }
    return null;
  }

  start(agent: AgentDiscovery, model = "default"): AgentVerification {
    if (agent.installation !== "found" || !agent.executablePath) throw new Error("Agent must be installed before connection verification");
    if (this.activeByAgent.has(agent.id)) throw new Error("Connection verification is already running for this Agent");
    const verification: AgentVerification = {
      verificationId: `agent-verification-${randomUUID()}`,
      agentId: agent.id,
      kind: "connection",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      requestedModel: safeModel(model),
      authentication: "unknown",
      evaluationSupport: "exploratory",
      userAcknowledgedModelUsage: true,
      checks: { exactOutput: false, structuredResult: false, isolatedWorkspace: false, toolEvents: false, timeoutControl: false, cancellationControl: false },
      steps: [],
      receipt: null,
      capabilityMatrix: buildAgentCapabilityMatrix(agent, null),
      error: null,
    };
    this.persist(verification);
    const controller = new AbortController();
    const promise = this.execute(verification.verificationId, agent, controller).finally(() => {
      this.active.delete(verification.verificationId);
      this.activeByAgent.delete(agent.id);
    });
    this.active.set(verification.verificationId, { controller, promise });
    this.activeByAgent.set(agent.id, verification.verificationId);
    return verification;
  }

  startConsistency(agent: AgentDiscovery, input: { model?: string; acknowledgeModelUsage: boolean }): AgentVerification {
    if (!input.acknowledgeModelUsage) throw new Error("You must confirm model usage and possible charges before consistency verification");
    if (agent.installation !== "found" || !agent.executablePath) throw new Error("Agent must be installed before consistency verification");
    if (this.activeByAgent.has(agent.id)) throw new Error("A verification is already running for this Agent");
    const verification: AgentVerification = {
      verificationId: `agent-verification-${randomUUID()}`,
      agentId: agent.id,
      kind: "consistency",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      requestedModel: safeModel(input.model ?? "default"),
      authentication: "unknown",
      evaluationSupport: "exploratory",
      userAcknowledgedModelUsage: true,
      checks: { exactOutput: false, structuredResult: false, isolatedWorkspace: false, toolEvents: false, timeoutControl: false, cancellationControl: false },
      steps: (["receipt", "tool-events", "timeout-control", "cancellation-control"] as const).map((id) => ({ id, status: "pending", startedAt: null, finishedAt: null, detail: "等待验证" })),
      receipt: null,
      capabilityMatrix: buildAgentCapabilityMatrix(agent, null),
      error: null,
    };
    this.persist(verification);
    const controller = new AbortController();
    const promise = this.executeConsistency(verification.verificationId, agent, controller).finally(() => {
      this.active.delete(verification.verificationId);
      this.activeByAgent.delete(agent.id);
    });
    this.active.set(verification.verificationId, { controller, promise });
    this.activeByAgent.set(agent.id, verification.verificationId);
    return verification;
  }

  cancel(verificationId: string): AgentVerification {
    const active = this.active.get(verificationId);
    if (!active) throw new Error("Agent verification is not running");
    const verification = this.get(verificationId);
    verification.status = "cancelling";
    verification.error = "Cancellation requested by user";
    this.persist(verification);
    active.controller.abort();
    return verification;
  }

  private setStep(verification: AgentVerification, id: AgentVerificationStep["id"], status: AgentVerificationStepStatus, detail: string): void {
    const step = verification.steps.find((item) => item.id === id);
    if (!step) return;
    if (status === "running") step.startedAt = new Date().toISOString();
    if (["passed", "failed", "not-reported", "cancelled"].includes(status)) step.finishedAt = new Date().toISOString();
    step.status = status;
    step.detail = detail;
    this.persist(verification);
  }

  private async executeConsistency(verificationId: string, agent: AgentDiscovery, controller: AbortController): Promise<void> {
    const verification = this.get(verificationId);
    verification.status = "running";
    verification.startedAt = new Date().toISOString();
    this.persist(verification);
    const environment = new LocalEnvironmentBackend(join(this.workspaceRoot, ".skillbenchmark", "verification-work"));
    let handle: Awaited<ReturnType<LocalEnvironmentBackend["provision"]>> | null = null;
    const executeProbe = (taskId: string, prompt: string, timeoutMs: number, signal: AbortSignal) => this.adapterFactory(agent).execute(
      { trial_id: `${verificationId}-${taskId}`, run_id: verificationId, task_id: taskId, profile_id: agent.id, condition_id: "none", repeat_index: 1, attempt: 1 },
      { task_id: taskId, prompt, mock_outputs: {} },
      { environment: handle!, model: verification.requestedModel, timeout_ms: timeoutMs, max_output_bytes: 256 * 1024, load_method: "explicit-file-read", mode: "controlled", signal, purpose: "verification" },
    );
    try {
      handle = await environment.provision({ trialId: verificationId, conditionId: "none", publicInput: "SKILLBENCHMARK_TOOL_MARKER" });
      verification.checks.isolatedWorkspace = handle.workdir.startsWith(join(this.workspaceRoot, ".skillbenchmark", "verification-work"));

      this.setStep(verification, "receipt", "running", "验证结构化输出和平台收据");
      const receiptExecution = await executeProbe("receipt", `Reply with exactly ${EXPECTED_OUTPUT}. Do not use tools and do not inspect files.`, this.timeoutMs, controller.signal);
      if (controller.signal.aborted) throw new Error("cancelled");
      verification.checks.structuredResult = receiptExecution.events.some((event) => event.kind === "platform.result");
      verification.checks.exactOutput = receiptExecution.receipt.artifact?.output.trim() === EXPECTED_OUTPUT;
      const platform = receiptExecution.receipt.platform_receipt;
      verification.receipt = platform ? { ...platform, input_tokens: receiptExecution.receipt.usage?.input_tokens ?? null, output_tokens: receiptExecution.receipt.usage?.output_tokens ?? null, estimated_cost: receiptExecution.receipt.usage?.estimated_cost ?? null } : null;
      if (receiptExecution.receipt.status !== "completed" || !verification.checks.exactOutput || !verification.checks.structuredResult) throw new Error(receiptExecution.receipt.failure_reason ?? "Agent did not return the expected structured result");
      verification.authentication = "ready";
      this.setStep(verification, "receipt", "passed", "结构化终态和执行收据已返回");

      this.setStep(verification, "tool-events", "running", "验证受限只读工具事件");
      const toolExecution = await executeProbe("tool-events", `SKILLBENCHMARK_TOOL_PROBE: Use one read-only tool to read ${handle.public_input_path}, then reply with exactly SKILLBENCHMARK_TOOL_OK. Do not edit files or use the network.`, this.timeoutMs, controller.signal);
      if (controller.signal.aborted) throw new Error("cancelled");
      verification.checks.toolEvents = toolExecution.events.some((event) => event.kind === "platform.tool") && toolExecution.receipt.artifact?.output.trim() === "SKILLBENCHMARK_TOOL_OK";
      this.setStep(verification, "tool-events", verification.checks.toolEvents ? "passed" : "failed", verification.checks.toolEvents ? "观察到受限工具事件和预期终态" : "未同时观察到工具事件和预期终态");

      this.setStep(verification, "timeout-control", "running", "验证当前 CLI 可在硬期限内终止");
      const timeoutExecution = await executeProbe("timeout-control", "SKILLBENCHMARK_TIMEOUT_PROBE: Wait without returning a final answer.", this.probeTimeoutMs, controller.signal);
      if (controller.signal.aborted) throw new Error("cancelled");
      verification.checks.timeoutControl = timeoutExecution.receipt.status === "timed_out";
      this.setStep(verification, "timeout-control", verification.checks.timeoutControl ? "passed" : "failed", verification.checks.timeoutControl ? "进程在硬期限内终止" : "未观察到预期的超时终止");

      this.setStep(verification, "cancellation-control", "running", "验证当前 CLI 响应取消信号");
      const probeController = new AbortController();
      const timer = setTimeout(() => probeController.abort(), this.cancelAfterMs);
      const combinedSignal = AbortSignal.any([controller.signal, probeController.signal]);
      const cancelExecution = await executeProbe("cancellation-control", "SKILLBENCHMARK_CANCEL_PROBE: Wait without returning a final answer.", this.timeoutMs, combinedSignal).finally(() => clearTimeout(timer));
      if (controller.signal.aborted) throw new Error("cancelled");
      verification.checks.cancellationControl = cancelExecution.receipt.status === "cancelled";
      this.setStep(verification, "cancellation-control", verification.checks.cancellationControl ? "passed" : "failed", verification.checks.cancellationControl ? "进程响应取消信号并退出" : "未观察到预期的取消终止");

      const usageReported = verification.receipt?.input_tokens !== null && verification.receipt?.input_tokens !== undefined || verification.receipt?.output_tokens !== null && verification.receipt?.output_tokens !== undefined;
      const requiredChecks = verification.checks.exactOutput && verification.checks.structuredResult && verification.checks.isolatedWorkspace && verification.checks.toolEvents && verification.checks.timeoutControl && verification.checks.cancellationControl;
      verification.status = requiredChecks ? "succeeded" : "failed";
      verification.evaluationSupport = requiredChecks && Boolean(verification.receipt?.session_id && verification.receipt.reported_model && usageReported && verification.receipt.estimated_cost !== null && verification.receipt.estimated_cost !== undefined) ? "verified" : "exploratory";
      if (!requiredChecks) verification.error = "One or more live consistency checks did not pass";
    } catch (error) {
      if (controller.signal.aborted) {
        verification.status = "cancelled";
        verification.error = "Consistency verification cancelled by user";
        for (const step of verification.steps.filter((item) => item.status === "pending" || item.status === "running")) this.setStep(verification, step.id, "cancelled", "验证已取消");
      } else {
        verification.status = "failed";
        verification.authentication = /auth|login|credential|unauthorized/i.test(error instanceof Error ? error.message : "") ? "required" : verification.authentication === "ready" ? "ready" : "failed";
        verification.error = error instanceof Error && error.message !== "cancelled" ? error.message : "Consistency verification failed before a valid receipt was produced";
        const running = verification.steps.find((step) => step.status === "running");
        if (running) this.setStep(verification, running.id, "failed", "该项验证未完成");
      }
    } finally {
      verification.finishedAt = new Date().toISOString();
      verification.capabilityMatrix = buildAgentCapabilityMatrix(agent, verification);
      this.persist(verification);
      if (handle) await environment.destroy(handle);
    }
  }

  private async execute(verificationId: string, agent: AgentDiscovery, controller: AbortController): Promise<void> {
    const verification = this.get(verificationId);
    verification.status = "running";
    verification.startedAt = new Date().toISOString();
    this.persist(verification);
    const environment = new LocalEnvironmentBackend(join(this.workspaceRoot, ".skillbenchmark", "verification-work"));
    let handle: Awaited<ReturnType<LocalEnvironmentBackend["provision"]>> | null = null;
    try {
      handle = await environment.provision({ trialId: verificationId, conditionId: "none", publicInput: EXPECTED_OUTPUT });
      verification.checks.isolatedWorkspace = handle.workdir.startsWith(join(this.workspaceRoot, ".skillbenchmark", "verification-work"));
      const execution = await this.adapterFactory(agent).execute(
        { trial_id: verificationId, run_id: verificationId, task_id: "connection-check", profile_id: agent.id, condition_id: "none", repeat_index: 1, attempt: 1 },
        { task_id: "connection-check", prompt: `Reply with exactly ${EXPECTED_OUTPUT}. Do not use tools and do not inspect files.`, mock_outputs: {} },
        { environment: handle, model: verification.requestedModel, timeout_ms: this.timeoutMs, max_output_bytes: 256 * 1024, load_method: "explicit-file-read", mode: "controlled", signal: controller.signal, purpose: "verification" },
      );
      verification.checks.structuredResult = execution.events.some((event) => event.kind === "platform.result");
      verification.checks.toolEvents = execution.events.some((event) => event.kind === "platform.tool");
      verification.checks.exactOutput = execution.receipt.artifact?.output.trim() === EXPECTED_OUTPUT;
      const platform = execution.receipt.platform_receipt;
      verification.receipt = platform ? { ...platform, input_tokens: execution.receipt.usage?.input_tokens ?? null, output_tokens: execution.receipt.usage?.output_tokens ?? null, estimated_cost: execution.receipt.usage?.estimated_cost ?? null } : null;
      const evidence = JSON.stringify(execution.events);
      if (execution.receipt.status === "completed" && verification.checks.exactOutput && verification.checks.structuredResult) {
        verification.status = "succeeded";
        verification.authentication = "ready";
      } else {
        verification.status = "failed";
        verification.authentication = /auth|login|credential|unauthorized/i.test(evidence) ? "required" : "failed";
        verification.error = verification.authentication === "required" ? "Agent authentication is required" : execution.receipt.failure_reason ?? "Agent did not return the expected structured result";
      }
    } catch {
      verification.status = "failed";
      verification.authentication = "failed";
      verification.error = "Connection verification failed before a valid receipt was produced";
    } finally {
      verification.finishedAt = new Date().toISOString();
      verification.capabilityMatrix = buildAgentCapabilityMatrix(agent, verification);
      this.persist(verification);
      if (handle) await environment.destroy(handle);
    }
  }

  async wait(verificationId: string): Promise<AgentVerification> {
    await this.active.get(verificationId)?.promise;
    return this.get(verificationId);
  }

  async close(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    this.db.close();
  }
}
