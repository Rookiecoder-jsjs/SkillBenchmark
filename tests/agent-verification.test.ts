import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceAgentVerificationStore } from "../apps/local-server/src/agent-verification-store.ts";
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
  await store.close();

  const reopened = new WorkspaceAgentVerificationStore(workspace, { adapterFactory: () => { throw new Error("must not execute while reading history"); } });
  assert.equal(reopened.latest("claude-code")?.verificationId, started.verificationId);
  await reopened.close();
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
