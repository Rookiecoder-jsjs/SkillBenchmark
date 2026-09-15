import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { ClaudeCodeAdapter, CodexAdapter, SubprocessRunnerAdapter } from "../packages/core/src/runner.ts";
import { LocalEnvironmentBackend } from "../packages/core/src/environment.ts";
import { executePlanAsync } from "../packages/core/src/scheduler.ts";
import { createRunPlan } from "../packages/core/src/plan.ts";
import { loadSuite } from "../packages/core/src/suite.ts";
import { SqliteStore } from "../packages/core/src/storage.ts";

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
