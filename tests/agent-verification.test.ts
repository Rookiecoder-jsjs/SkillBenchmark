import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceAgentVerificationStore } from "../apps/local-server/src/agent-verification-store.ts";
import { buildAgentCapabilityMatrix } from "../apps/local-server/src/agent-capabilities.ts";
import { SubprocessRunnerAdapter } from "../packages/core/src/runner.ts";

const installedAgent = {
  id: "claude-code" as const,
  name: "Claude Code",
  installation: "found" as const,
  authentication: "unknown" as const,
  evaluationSupport: "exploratory" as const,
  executablePath: "/fake/claude",
  version: "test",
  capabilities: ["structured-output"],
  detectedAt: "2026-09-17T00:00:00.000Z",
  evidence: [],
};

test("agent verification persists an honest bounded connection receipt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skillbenchmark-agent-verification-"));
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const store = new WorkspaceAgentVerificationStore(workspace, {
    adapterFactory: () => new SubprocessRunnerAdapter("fake", process.execPath, "claude-code", (prompt) => [fakeRunner, `PLATFORM_RECEIPT ${prompt}`]),
    timeoutMs: 1_000,
  });
  const started = store.start(installedAgent, "claude-requested");
  assert.equal(started.status, "queued");
  const completed = await store.wait(started.verificationId);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.authentication, "ready");
  assert.equal(completed.evaluationSupport, "exploratory", "one connection check must not claim full platform verification");
  assert.equal(completed.receipt?.reported_model, "claude-test-actual");
  assert.equal(completed.receipt?.session_id, "session-test");
  assert.equal(completed.receipt?.estimated_cost, 0.0123);
  assert.equal(completed.checks.exactOutput, true);
  const matrix = new Map(completed.capabilityMatrix.map((capability) => [capability.id, capability]));
  assert.equal(matrix.get("structured-output")?.status, "verified");
  assert.equal(matrix.get("session-receipt")?.status, "verified");
  assert.equal(matrix.get("model-receipt")?.status, "verified");
  assert.equal(matrix.get("usage-receipt")?.status, "verified");
  assert.equal(matrix.get("cost-receipt")?.status, "verified");
  assert.equal(matrix.get("tool-events")?.status, "exploratory", "minimal connection verification does not exercise tools");
  await store.close();

  const reopened = new WorkspaceAgentVerificationStore(workspace, { adapterFactory: () => { throw new Error("must not execute while reading history"); } });
  assert.equal(reopened.latest("claude-code")?.verificationId, started.verificationId);
  await reopened.close();
});

test("capability matrix keeps discovery, connection and Adapter evidence scopes separate", () => {
  const base = new Map(buildAgentCapabilityMatrix(installedAgent, null).map((capability) => [capability.id, capability]));
  assert.equal(base.get("launch")?.status, "verified");
  assert.equal(base.get("structured-output")?.status, "exploratory");
  assert.equal(base.get("timeout-control")?.source, "adapter-conformance");
  assert.match(base.get("timeout-control")?.detail ?? "", /不代表.*本机/i);

  const codexVerification = {
    verificationId: "agent-verification-00000000-0000-0000-0000-000000000000",
    agentId: "codex",
    status: "succeeded",
    createdAt: "2026-09-17T00:00:00.000Z",
    startedAt: "2026-09-17T00:00:00.000Z",
    finishedAt: "2026-09-17T00:00:01.000Z",
    requestedModel: "default",
    authentication: "ready",
    evaluationSupport: "exploratory",
    checks: { exactOutput: true, structuredResult: true, isolatedWorkspace: true, toolEvents: false },
    receipt: { requested_model: "default", reported_model: null, session_id: "codex-thread", input_tokens: 1, output_tokens: 1, estimated_cost: null },
    capabilityMatrix: [],
    error: null,
  } as const;
  const withoutOptionalReceipts = buildAgentCapabilityMatrix({ ...installedAgent, id: "codex", name: "Codex" }, codexVerification);
  const matrix = new Map(withoutOptionalReceipts.map((capability) => [capability.id, capability]));
  assert.equal(matrix.get("model-receipt")?.status, "not-reported");
  assert.equal(matrix.get("cost-receipt")?.status, "not-reported");
  assert.equal(matrix.get("tool-events")?.status, "exploratory");
});

test("agent verification distinguishes authentication failure from malformed output", async () => {
  for (const scenario of [
    { prefix: "AUTH_REQUIRED", authentication: "required", error: /authentication is required/i },
    { prefix: "MALFORMED", authentication: "failed", error: /structured result/i },
  ]) {
    const workspace = await mkdtemp(join(tmpdir(), "skillbenchmark-agent-verification-failure-"));
    const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
    const store = new WorkspaceAgentVerificationStore(workspace, {
      adapterFactory: () => new SubprocessRunnerAdapter("fake", process.execPath, "claude-code", (prompt) => [fakeRunner, `${scenario.prefix} ${prompt}`]),
      timeoutMs: 1_000,
    });
    const completed = await store.wait(store.start(installedAgent).verificationId);
    assert.equal(completed.status, "failed");
    assert.equal(completed.authentication, scenario.authentication);
    assert.match(completed.error ?? "", scenario.error);
    await store.close();
  }
});

test("agent verification bounds timeout and persists cancellation on shutdown", async () => {
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const timeoutWorkspace = await mkdtemp(join(tmpdir(), "skillbenchmark-agent-verification-timeout-"));
  const timeoutStore = new WorkspaceAgentVerificationStore(timeoutWorkspace, {
    adapterFactory: () => new SubprocessRunnerAdapter("fake", process.execPath, "claude-code", (prompt) => [fakeRunner, `TIMEOUT ${prompt}`]),
    timeoutMs: 30,
  });
  const timedOut = await timeoutStore.wait(timeoutStore.start(installedAgent).verificationId);
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.error ?? "", /timeout|expected structured result/i);
  await timeoutStore.close();

  const cancelWorkspace = await mkdtemp(join(tmpdir(), "skillbenchmark-agent-verification-cancel-"));
  const cancelStore = new WorkspaceAgentVerificationStore(cancelWorkspace, {
    adapterFactory: () => new SubprocessRunnerAdapter("fake", process.execPath, "claude-code", (prompt) => [fakeRunner, `TIMEOUT ${prompt}`]),
    timeoutMs: 10_000,
  });
  const started = cancelStore.start(installedAgent);
  await cancelStore.close();
  const reopened = new WorkspaceAgentVerificationStore(cancelWorkspace);
  assert.equal(reopened.get(started.verificationId).status, "failed");
  await reopened.close();
});

test("full consistency verification requires consent and persists live capability checks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skillbenchmark-agent-consistency-"));
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const store = new WorkspaceAgentVerificationStore(workspace, {
    adapterFactory: () => new SubprocessRunnerAdapter("fake", process.execPath, "claude-code", (prompt) => [fakeRunner, prompt.includes("SKILLBENCHMARK_TOOL_PROBE") ? prompt : prompt.includes("SKILLBENCHMARK_TIMEOUT_PROBE") || prompt.includes("SKILLBENCHMARK_CANCEL_PROBE") ? prompt : `PLATFORM_RECEIPT ${prompt}`]),
    timeoutMs: 1_000,
    probeTimeoutMs: 30,
    cancelAfterMs: 20,
  });
  assert.throws(() => store.startConsistency(installedAgent, { model: "claude-requested", acknowledgeModelUsage: false }), /confirm model usage/i);
  const started = store.startConsistency(installedAgent, { model: "claude-requested", acknowledgeModelUsage: true });
  assert.equal(started.kind, "consistency");
  assert.equal(started.userAcknowledgedModelUsage, true);
  const completed = await store.wait(started.verificationId);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.evaluationSupport, "verified");
  assert.deepEqual(completed.steps.map((step) => [step.id, step.status]), [
    ["receipt", "passed"],
    ["tool-events", "passed"],
    ["timeout-control", "passed"],
    ["cancellation-control", "passed"],
  ]);
  const matrix = new Map(completed.capabilityMatrix.map((capability) => [capability.id, capability]));
  assert.equal(matrix.get("tool-events")?.source, "connection");
  assert.equal(matrix.get("timeout-control")?.source, "connection");
  assert.equal(matrix.get("cancellation-control")?.source, "connection");
  await store.close();

  const reopened = new WorkspaceAgentVerificationStore(workspace);
  assert.equal(reopened.latestConsistency("claude-code")?.verificationId, started.verificationId);
  await reopened.close();
});

test("full consistency verification can be cancelled without leaving an active job", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skillbenchmark-agent-consistency-cancel-"));
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const store = new WorkspaceAgentVerificationStore(workspace, {
    adapterFactory: () => new SubprocessRunnerAdapter("fake", process.execPath, "claude-code", (prompt) => [fakeRunner, `TIMEOUT ${prompt}`]),
    timeoutMs: 10_000,
  });
  const started = store.startConsistency(installedAgent, { model: "default", acknowledgeModelUsage: true });
  const cancelling = store.cancel(started.verificationId);
  assert.equal(cancelling.status, "cancelling");
  const cancelled = await store.wait(started.verificationId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.evaluationSupport, "exploratory");
  assert.throws(() => store.cancel(started.verificationId), /not running/i);
  await store.close();
});
