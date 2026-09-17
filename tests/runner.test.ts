import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ClaudeCodeAdapter, CodexAdapter, SubprocessRunnerAdapter } from "../packages/core/src/runner.ts";
import { LocalEnvironmentBackend } from "../packages/core/src/environment.ts";
import { executePlanAsync } from "../packages/core/src/scheduler.ts";
import { createRunPlan } from "../packages/core/src/plan.ts";
import { loadSuite } from "../packages/core/src/suite.ts";
import { SqliteStore } from "../packages/core/src/storage.ts";
import { runSubprocess } from "../packages/core/src/subprocess.ts";

test("subprocess adapter probes and captures structured final output", async () => {
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const adapter = new SubprocessRunnerAdapter("fake", process.execPath, "fake", (prompt) => [fakeRunner, prompt]);
  const capability = await adapter.probe();
  assert.equal(capability.status, "exploratory");
  const dir = await mkdtemp(join(tmpdir(), "skillbenchmark-runner-"));
  const environment = new LocalEnvironmentBackend(dir);
  const handle = await environment.provision({ trialId: "trial-runner", conditionId: "none", publicInput: "REAL_OK" });
  const execution = await adapter.execute({ trial_id: "trial-runner", run_id: "run", task_id: "task", profile_id: "mock", condition_id: "none", repeat_index: 1, attempt: 1 }, { task_id: "task", prompt: "REAL_OK", mock_outputs: {} }, { environment: handle, model: "deterministic", timeout_ms: 1000, load_method: "explicit-file-read", mode: "controlled" });
  assert.equal(execution.receipt.status, "completed");
  assert.equal(execution.receipt.artifact?.output, "real ok");
  assert.ok(execution.events.some((event) => event.producer === "platform"));
  await environment.destroy(handle);
});

test("Codex and Claude adapters pass a frozen non-default model as one argument", () => {
  const codexArgs = new CodexAdapter().argsBuilder("prompt", "gpt-5.5");
  const claudeArgs = new ClaudeCodeAdapter().argsBuilder("prompt", "claude-sonnet-test");
  assert.deepEqual(codexArgs.slice(codexArgs.indexOf("--model"), codexArgs.indexOf("--model") + 2), ["--model", "gpt-5.5"]);
  assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf("--model"), claudeArgs.indexOf("--model") + 2), ["--model", "claude-sonnet-test"]);
});

test("subprocess adapter records reported model, session, usage and platform errors", async () => {
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const adapter = new SubprocessRunnerAdapter("fake", process.execPath, "claude-code", (prompt) => [fakeRunner, prompt]);
  const environment = new LocalEnvironmentBackend(await mkdtemp(join(tmpdir(), "skillbenchmark-receipt-")));
  const handle = await environment.provision({ trialId: "trial-receipt", conditionId: "none", publicInput: "PLATFORM_RECEIPT" });
  const execution = await adapter.execute({ trial_id: "trial-receipt", run_id: "run", task_id: "task", profile_id: "claude", condition_id: "none", repeat_index: 1, attempt: 1 }, { task_id: "task", prompt: "PLATFORM_RECEIPT", mock_outputs: {} }, { environment: handle, model: "claude-requested", timeout_ms: 1000, load_method: "explicit-file-read", mode: "controlled" });
  assert.deepEqual(execution.receipt.platform_receipt, { requested_model: "claude-requested", reported_model: "claude-test-actual", session_id: "session-test" });
  assert.deepEqual(execution.receipt.usage, { input_tokens: 21, output_tokens: 8, estimated_cost: 0.0123 });
  assert.ok(execution.events.some((event) => event.kind === "platform.session" && event.data.model === "claude-test-actual"));
  const rawEvents = execution.events.filter((event) => event.producer === "platform").map((event) => String(event.data.raw ?? "")).join("\n");
  assert.doesNotMatch(rawEvents, /fixture-sensitive-token/);
  assert.match(rawEvents, /\[redacted\]/);
  assert.deepEqual(execution.events.find((event) => event.kind === "platform.result")?.data.usage, { input_tokens: 21, output_tokens: 8 }, "token counts are measurements, not credentials");

  const failed = await adapter.execute({ trial_id: "trial-error", run_id: "run", task_id: "task", profile_id: "claude", condition_id: "none", repeat_index: 1, attempt: 1 }, { task_id: "task", prompt: "PLATFORM_ERROR", mock_outputs: {} }, { environment: handle, model: "default", timeout_ms: 1000, load_method: "explicit-file-read", mode: "controlled" });
  assert.equal(failed.receipt.status, "errored", "a structured platform error must not become a successful Trial");
  await environment.destroy(handle);
});

test("platform dialects normalize terminal, tool and failure events without inventing model identity", async () => {
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const environment = new LocalEnvironmentBackend(await mkdtemp(join(tmpdir(), "skillbenchmark-dialects-")));
  const handle = await environment.provision({ trialId: "trial-dialects", conditionId: "none", publicInput: "dialects" });
  const spec = { trial_id: "trial-dialects", run_id: "run", task_id: "task", profile_id: "platform", condition_id: "none" as const, repeat_index: 1, attempt: 1 };
  const context = { environment: handle, model: "requested-model", timeout_ms: 1000, load_method: "explicit-file-read" as const, mode: "controlled" as const };

  const codex = new SubprocessRunnerAdapter("codex", process.execPath, "codex", (prompt) => [fakeRunner, `CODEX_DIALECT ${prompt}`]);
  const codexExecution = await codex.execute(spec, { task_id: "task", prompt: "answer", mock_outputs: {} }, context);
  assert.equal(codexExecution.receipt.status, "completed");
  assert.equal(codexExecution.receipt.artifact?.output, "real ok");
  assert.deepEqual(codexExecution.receipt.platform_receipt, { requested_model: "requested-model", reported_model: null, session_id: "codex-thread-test" });
  assert.deepEqual(codexExecution.receipt.usage, { input_tokens: 13, output_tokens: 5, estimated_cost: null });
  assert.ok(codexExecution.events.some((event) => event.kind === "platform.tool"));
  assert.ok(codexExecution.events.some((event) => event.kind === "platform.message"));

  const claude = new SubprocessRunnerAdapter("claude", process.execPath, "claude-code", (prompt) => [fakeRunner, `CLAUDE_DIALECT ${prompt}`]);
  const claudeExecution = await claude.execute({ ...spec, trial_id: "trial-claude-dialect" }, { task_id: "task", prompt: "answer", mock_outputs: {} }, context);
  assert.equal(claudeExecution.receipt.status, "completed");
  assert.equal(claudeExecution.receipt.platform_receipt?.reported_model, "claude-reported");
  assert.equal(claudeExecution.receipt.platform_receipt?.session_id, "claude-session-test");
  assert.ok(claudeExecution.events.some((event) => event.kind === "platform.tool"));

  const failed = new SubprocessRunnerAdapter("codex", process.execPath, "codex", (prompt) => [fakeRunner, `CODEX_FAILED ${prompt}`]);
  const failedExecution = await failed.execute({ ...spec, trial_id: "trial-codex-failed" }, { task_id: "task", prompt: "answer", mock_outputs: {} }, context);
  assert.equal(failedExecution.receipt.status, "errored");
  assert.ok(failedExecution.events.some((event) => event.kind === "platform.error"));
  await environment.destroy(handle);
});

test("async scheduler runs a real adapter through isolated environments", async () => {
  const suitePath = join(await mkdtemp(join(tmpdir(), "skillbenchmark-suite-real-")), "suite.json");
  await writeFile(suitePath, JSON.stringify({ suite_id: "real-smoke", tasks: [
    { task_id: "real-1", family_id: "runner", source_group: "real-1", split: "train", prompt: "REAL_OK", expected_output: "real ok", mock_outputs: {}, tags: [] },
    { task_id: "real-2", family_id: "runner", source_group: "real-2", split: "train", prompt: "REAL_OK", expected_output: "real ok", mock_outputs: {}, tags: [] }
  ] }));
  const suite = await loadSuite(suitePath);
  const plan = createRunPlan(suite, { conditions: ["none"], repeats: 1, runId: "run-real-smoke", budget: { max_trials: 2, max_attempts: 2, concurrency: 2, timeout_ms: 1000 } });
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const adapter = new SubprocessRunnerAdapter("fake", process.execPath, "fake", (prompt) => [fakeRunner, prompt]);
  const work = await mkdtemp(join(tmpdir(), "skillbenchmark-worker-"));
  const output = await mkdtemp(join(tmpdir(), "skillbenchmark-real-output-"));
  const store = new SqliteStore(join(output, "metadata.sqlite"), join(output, "objects"));
  const report = await executePlanAsync(suite, plan, adapter, new LocalEnvironmentBackend(work), store);
  assert.equal(report.results.length, 2);
  assert.equal(report.summary.by_condition.none.success_rate, 1);
  store.close();
});

test("adapter timeout is classified as task failure", async () => {
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const adapter = new SubprocessRunnerAdapter("fake", process.execPath, "fake", (prompt) => [fakeRunner, prompt]);
  const dir = await mkdtemp(join(tmpdir(), "skillbenchmark-timeout-"));
  const environment = new LocalEnvironmentBackend(dir);
  const handle = await environment.provision({ trialId: "trial-timeout", conditionId: "none", publicInput: "TIMEOUT" });
  const execution = await adapter.execute({ trial_id: "trial-timeout", run_id: "run", task_id: "task", profile_id: "mock", condition_id: "none", repeat_index: 1, attempt: 1 }, { task_id: "task", prompt: "TIMEOUT", mock_outputs: {} }, { environment: handle, model: "deterministic", timeout_ms: 30, load_method: "explicit-file-read", mode: "controlled" });
  assert.equal(execution.receipt.status, "timed_out");
  assert.equal(execution.receipt.failure_kind, "task");
  await environment.destroy(handle);
});

test("shared subprocess runner bounds a hung child", async () => {
  const result = await runSubprocess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"], timeout_ms: 30 });
  assert.equal(result.timedOut, true);
  assert.equal(result.outputLimitExceeded, false);
});

test("shared subprocess runner aborts and removes a cancelled child", async () => {
  const controller = new AbortController();
  const pending = runSubprocess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"], timeout_ms: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
});

test("shared subprocess runner removes detached descendants", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "skillbenchmark-process-tree-"));
  const pidFile = join(dir, "child.pid");
  const script = "const { spawn } = require(\"node:child_process\"); const fs = require(\"node:fs\"); const child = spawn(\"sleep\", [\"100\"], { detached: true, stdio: \"ignore\" }); fs.writeFileSync(process.argv[1], String(child.pid)); setTimeout(() => {}, 10000);";
  let childPid = 0;
  try {
    const result = await runSubprocess({ command: process.execPath, args: ["-e", script, pidFile], timeout_ms: 30 });
    childPid = Number(await readFile(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = String(spawnSync("ps", ["-p", String(childPid), "-o", "pid=,stat=,command="], { encoding: "utf8" }).stdout ?? "").trim();
    assert.equal(result.timedOut, true);
    assert.equal(status, "");
  } finally {
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter output is bounded before parsing", async () => {
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const adapter = new SubprocessRunnerAdapter("fake", process.execPath, "fake", (prompt) => [fakeRunner, prompt]);
  const dir = await mkdtemp(join(tmpdir(), "skillbenchmark-output-limit-"));
  const environment = new LocalEnvironmentBackend(dir);
  const handle = await environment.provision({ trialId: "trial-output-limit", conditionId: "none", publicInput: "HUGE_OUTPUT" });
  const execution = await adapter.execute({ trial_id: "trial-output-limit", run_id: "run", task_id: "task", profile_id: "fake", condition_id: "none", repeat_index: 1, attempt: 1 }, { task_id: "task", prompt: "HUGE_OUTPUT", mock_outputs: {} }, { environment: handle, model: "default", timeout_ms: 1000, max_output_bytes: 1024, load_method: "explicit-file-read", mode: "controlled" });
  assert.equal(execution.receipt.status, "errored");
  assert.match(execution.receipt.failure_reason ?? "", /output limit/);
  await environment.destroy(handle);
});

test("scheduler bounds environment provisioning", async () => {
  const suitePath = join(await mkdtemp(join(tmpdir(), "skillbenchmark-deadline-suite-")), "suite.json");
  await writeFile(suitePath, JSON.stringify({ suite_id: "deadline-smoke", tasks: [{ task_id: "deadline-1", family_id: "deadline", source_group: "deadline-1", split: "train", prompt: "deadline", expected_output: "ok", mock_outputs: {}, tags: [] }] }));
  const suite = await loadSuite(suitePath);
  const plan = createRunPlan(suite, { conditions: ["none"], repeats: 1, runId: "run-deadline", budget: { max_trials: 1, max_attempts: 1, concurrency: 1, timeout_ms: 1000, max_duration_ms: 40 } });
  const environment = { provision: async () => new Promise<never>(() => undefined), collect: async () => ({ root_dir: "", workdir: "", skill_path: null }), destroy: async () => undefined };
  const started = Date.now();
  const report = await executePlanAsync(suite, plan, { name: "deadline", supportedModes: ["controlled"], probe: async () => ({ adapter: "deadline", platform: "test", status: "verified", version: "1", capabilities: [], evidence: [] }), execute: async () => { throw new Error("should not execute"); } }, environment);
  assert.ok(Date.now() - started < 1000);
  assert.equal(report.results[0].receipt.failure_kind, "infrastructure");
});

test("scheduler retries infrastructure errors under the global attempt budget", async () => {
  const suitePath = join(await mkdtemp(join(tmpdir(), "skillbenchmark-retry-suite-")), "suite.json");
  await writeFile(suitePath, JSON.stringify({ suite_id: "retry-smoke", tasks: [{ task_id: "retry-1", family_id: "runner", source_group: "retry-1", split: "train", prompt: "INFRA_RETRY", expected_output: "real ok", mock_outputs: {}, tags: [] }] }));
  const suite = await loadSuite(suitePath);
  const plan = createRunPlan(suite, { conditions: ["none"], repeats: 1, runId: "run-retry", budget: { max_trials: 1, max_attempts: 2, concurrency: 1, timeout_ms: 1000 } });
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const adapter = new SubprocessRunnerAdapter("fake", process.execPath, "fake", (prompt) => [fakeRunner, prompt]);
  const work = await mkdtemp(join(tmpdir(), "skillbenchmark-retry-worker-"));
  const report = await executePlanAsync(suite, plan, adapter, new LocalEnvironmentBackend(work));
  assert.equal(report.results[0].spec.attempt, 2);
  assert.equal(report.results[0].grade.outcome, "pass");
});

test("scheduler reports progress, uses condition-specific Skills and cancels queued trials", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  const plan = createRunPlan(suite, { conditions: ["none", "candidate"], repeats: 1, runId: "run-progress", budget: { max_trials: 6, max_attempts: 6, concurrency: 1, timeout_ms: 10_000 } });
  const controller = new AbortController();
  const provisioned: Array<{ conditionId: string; skillDir?: string }> = [];
  const progress: string[] = [];
  const environment = {
    provision: async (request: { trialId: string; conditionId: "none" | "candidate"; publicInput: string; skillDir?: string }) => {
      provisioned.push({ conditionId: request.conditionId, skillDir: request.skillDir });
      return { id: request.trialId, root_dir: "/tmp", workdir: "/tmp", public_input_path: "/tmp/input", skill_path: request.skillDir ?? null, snapshot: { backend: "test", image_digest: "test", tool_versions: {}, network_policy: "none" as const, isolation_receipt: { root_dir: "/tmp", hidden_mounts: [], user_config_visible: false } } };
    },
    collect: async () => ({ root_dir: "/tmp", workdir: "/tmp", skill_path: null }),
    destroy: async () => undefined,
  };
  let calls = 0;
  const adapter = {
    name: "progress",
    supportedModes: ["controlled" as const],
    probe: async () => ({ adapter: "progress", platform: "test", status: "verified" as const, version: "1", capabilities: [], evidence: [] }),
    execute: async (spec: typeof plan.trials[number]) => {
      calls += 1;
      if (calls === 2) controller.abort();
      return { events: [], receipt: { trial_id: spec.trial_id, status: "completed" as const, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), artifact: null, failure_reason: null, failure_kind: null } };
    },
  };
  const report = await executePlanAsync(suite, plan, adapter, environment, undefined, { skill_dirs: { candidate: "/frozen/candidate" }, signal: controller.signal, on_progress: (event) => progress.push(event.type) });
  assert.equal(provisioned.find((item) => item.conditionId === "none")?.skillDir, undefined);
  assert.equal(provisioned.find((item) => item.conditionId === "candidate")?.skillDir, "/frozen/candidate");
  assert.ok(report.results.some((result) => result.receipt.status === "cancelled"));
  assert.ok(progress.includes("trial.running"));
  assert.ok(progress.includes("trial.finished"));
});

test("unverified native mode is rejected instead of silently changing injection", async () => {
  const suite = await loadSuite("suites/smoke/suite.json");
  const plan = createRunPlan(suite, { conditions: ["none"], mode: "native", load_method: "native", repeats: 1, runId: "run-native-unsupported", budget: { max_trials: 3, max_attempts: 3, concurrency: 1, timeout_ms: 1000 } });
  const fakeRunner = resolve("tests/fixtures/fake-runner.mjs");
  const adapter = new SubprocessRunnerAdapter("fake", process.execPath, "fake", (prompt) => [fakeRunner, prompt]);
  const work = await mkdtemp(join(tmpdir(), "skillbenchmark-native-worker-"));
  await assert.rejects(executePlanAsync(suite, plan, adapter, new LocalEnvironmentBackend(work)), /does not support native mode/);
});

test("Claude adapter supports native loading and records background Skill paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbenchmark-native-"));
  const skill = join(root, "skill");
  const background = join(root, "background");
  await mkdir(skill);
  await mkdir(background);
  await writeFile(join(skill, "SKILL.md"), "# Native\n");
  await writeFile(join(background, "SKILL.md"), "# Background\n");
  const environment = new LocalEnvironmentBackend(join(root, "work"));
  const handle = await environment.provision({ trialId: "trial-native", conditionId: "candidate", publicInput: "native smoke", skillDir: skill, backgroundSkillDirs: [background] });
  assert.equal(handle.background_skill_paths?.length, 1);
  assert.equal(await readFile(join(handle.background_skill_paths?.[0] ?? "", "SKILL.md"), "utf8"), "# Background\n");
  const adapter = new ClaudeCodeAdapter(resolve("tests/fixtures/fake-claude.mjs"));
  assert.equal((await adapter.probe()).status, "exploratory");
  const execution = await adapter.execute({ trial_id: "trial-native", run_id: "run", task_id: "task", profile_id: "claude", condition_id: "candidate", repeat_index: 1, attempt: 1 }, { task_id: "task", prompt: "native smoke", mock_outputs: {} }, { environment: handle, model: "default", timeout_ms: 1000, load_method: "native", mode: "native" });
  assert.equal(execution.receipt.artifact?.output, "native ok");
  assert.equal(execution.events.find((event) => event.kind === "skill.provisioned")?.data.load_observation, "platform-managed");
  await environment.destroy(handle);
});
