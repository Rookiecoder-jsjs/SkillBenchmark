import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { LocalEnvironmentBackend } from "../../../packages/core/src/environment.ts";
import { ClaudeCodeAdapter, CodexAdapter, type RunnerAdapter } from "../../../packages/core/src/runner.ts";
import type { AgentDiscovery, AgentId } from "./discovery.ts";
import { buildAgentCapabilityMatrix, type AgentCapabilityEvidence } from "./agent-capabilities.ts";

export type AgentVerificationStatus = "queued" | "running" | "succeeded" | "failed";

export interface AgentVerification {
  verificationId: string;
  agentId: AgentId;
  status: AgentVerificationStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requestedModel: string;
  authentication: "unknown" | "ready" | "required" | "failed";
  evaluationSupport: "exploratory";
  checks: { exactOutput: boolean; structuredResult: boolean; isolatedWorkspace: boolean; toolEvents: boolean };
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
  readonly active = new Map<string, ActiveVerification>();
  readonly activeByAgent = new Map<AgentId, string>();

  constructor(workspaceRoot: string, options: { adapterFactory?: (agent: AgentDiscovery) => RunnerAdapter; timeoutMs?: number } = {}) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.adapterFactory = options.adapterFactory ?? ((agent) => agent.id === "codex" ? new CodexAdapter(agent.executablePath!) : new ClaudeCodeAdapter(agent.executablePath!));
    this.timeoutMs = options.timeoutMs ?? 60_000;
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
    const interrupted = this.db.prepare("SELECT verification_json FROM agent_verifications WHERE status IN ('queued', 'running')").all() as unknown as Array<{ verification_json: string }>;
    for (const row of interrupted) {
      const verification = JSON.parse(row.verification_json) as AgentVerification;
      verification.status = "failed";
      verification.finishedAt = new Date().toISOString();
      verification.authentication = "failed";
      verification.error = "Local service stopped before connection verification finished";
      this.persist(verification);
    }
  }

  private persist(verification: AgentVerification): void {
    this.db.prepare("INSERT OR REPLACE INTO agent_verifications(verification_id, agent_id, status, created_at, verification_json) VALUES (?, ?, ?, ?, ?)").run(verification.verificationId, verification.agentId, verification.status, verification.createdAt, JSON.stringify(verification));
  }

  get(verificationId: string): AgentVerification {
    const row = this.db.prepare("SELECT verification_json FROM agent_verifications WHERE verification_id = ?").get(verificationId) as { verification_json: string } | undefined;
    if (!row) throw new Error(`Agent verification not found: ${verificationId}`);
    return JSON.parse(row.verification_json) as AgentVerification;
  }

  latest(agentId: AgentId): AgentVerification | null {
    const row = this.db.prepare("SELECT verification_json FROM agent_verifications WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1").get(agentId) as { verification_json: string } | undefined;
    return row ? JSON.parse(row.verification_json) as AgentVerification : null;
  }

  start(agent: AgentDiscovery, model = "default"): AgentVerification {
    if (agent.installation !== "found" || !agent.executablePath) throw new Error("Agent must be installed before connection verification");
    if (this.activeByAgent.has(agent.id)) throw new Error("Connection verification is already running for this Agent");
    const verification: AgentVerification = {
      verificationId: `agent-verification-${randomUUID()}`,
      agentId: agent.id,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      requestedModel: safeModel(model),
      authentication: "unknown",
      evaluationSupport: "exploratory",
      checks: { exactOutput: false, structuredResult: false, isolatedWorkspace: false, toolEvents: false },
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
