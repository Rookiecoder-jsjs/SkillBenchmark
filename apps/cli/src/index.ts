import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { sha256 } from "../../../packages/core/src/hash.ts";
import { createRunPlan } from "../../../packages/core/src/plan.ts";
import { executePlan } from "../../../packages/core/src/pipeline.ts";
import { importSkillSnapshot } from "../../../packages/core/src/snapshot.ts";
import { loadSuite } from "../../../packages/core/src/suite.ts";
import { writeRunArtifacts } from "../../../packages/core/src/storage.ts";
import { SqliteStore } from "../../../packages/core/src/storage.ts";
import { attachStatistics, defaultGatePolicy } from "../../../packages/core/src/statistics.ts";
import { CodexAdapter, ClaudeCodeAdapter } from "../../../packages/core/src/runner.ts";
import { LocalEnvironmentBackend } from "../../../packages/core/src/environment.ts";
import { executePlanAsync } from "../../../packages/core/src/scheduler.ts";
import { applyValidationGate, buildEvidenceView, createCandidateSnapshot, maintainWiki, writeEvolutionArtifacts } from "../../../packages/core/src/evolution.ts";
import { FileRegistry } from "../../../packages/core/src/registry.ts";
import { cleanupActiveSubprocesses } from "../../../packages/core/src/subprocess.ts";
import { resolveWorkspaceRoot } from "../../local-server/src/discovery.ts";
import { startLocalWorkbench } from "../../local-server/src/server.ts";

const root = resolve(import.meta.dirname, "../../../");
const demoSuite = resolve(root, "suites/smoke/suite.json");
let shuttingDown = false;
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanupActiveSubprocesses("SIGKILL");
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 250);
}
process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));
const usage = `SkillBenchmark v0.1\n\n用法:\n  npm run dev                          启动本地 Web 工作台\n  npm run demo                         运行内置 smoke Suite\n  npm run skillbenchmark -- ui [--workspace <dir>] [--port <port>] [--no-open]\n  npm run skillbenchmark -- plan <suite.json> [output-dir]\n  npm run skillbenchmark -- run <suite.json> [output-dir]\n  npm run skillbenchmark -- run-adapter <codex|claude-code> <suite.json> <skill-dir> [output-dir]\n  npm run skillbenchmark -- snapshot <skill-dir>\n  npm run skillbenchmark -- profile inspect <codex|claude-code>\n  npm run skillbenchmark -- evolve <suite.json> <skill-dir> [output-dir]\n  npm run skillbenchmark -- proposal show <proposal.json>\n  npm run skillbenchmark -- compare <report.json>\n  npm run skillbenchmark -- release publish <skill-dir> <gate.json> <registry-dir>\n  npm run skillbenchmark -- release export <registry-dir> <release-id> <platform> <output-dir>\n  npm run skillbenchmark -- release rollback <registry-dir> <release-id> [expected-current-digest]\n`;

function uiOptions(args: string[]): { workspace?: string; port: number; openBrowser: boolean } {
  let workspace: string | undefined;
  let port = 4317;
  let openBrowser = true;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--no-open") { openBrowser = false; continue; }
    if (value === "--workspace") {
      workspace = args[++index];
      if (!workspace) throw new Error("--workspace 需要目录路径");
      continue;
    }
    if (value === "--port") {
      const parsed = Number(args[++index]);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error("--port 必须是 0 到 65535 的整数");
      port = parsed;
      continue;
    }
    throw new Error(`未知 ui 参数：${value}`);
  }
  return { workspace, port, openBrowser };
}

async function run(suitePath: string, outputDir: string): Promise<void> {
  const suite = await loadSuite(suitePath);
  const plan = createRunPlan(suite, { repeats: 1 });
  const store = new SqliteStore(join(outputDir, "metadata.sqlite"), join(outputDir, "objects"));
  let report: ReturnType<typeof attachStatistics> | null = null;
  try {
    report = attachStatistics(executePlan(suite, plan, store));
    store.saveReport(report);
    await writeRunArtifacts(outputDir, plan, report);
  } finally {
    store.close();
  }
  if (!report) throw new Error("run did not produce a report");
  console.log(`run=${report.run_id}`);
  for (const [condition, summary] of Object.entries(report.summary.by_condition)) console.log(`${condition}: ${summary.passed}/${summary.total} passed (${summary.success_rate === null ? "unknown" : `${(summary.success_rate * 100).toFixed(1)}%`})`);
  console.log(`报告已写入 ${outputDir}`);
}

async function plan(suitePath: string, outputDir: string): Promise<void> {
  const suite = await loadSuite(suitePath);
  const runPlan = createRunPlan(suite, { repeats: 1 });
  await writeRunArtifacts(outputDir, runPlan);
  console.log(`计划 ${runPlan.run_id} 已写入 ${outputDir}/plan.json，共 ${runPlan.trials.length} 个 Trial`);
}

async function runAdapter(platform: string, suitePath: string, skillDir: string, outputDir: string): Promise<void> {
  const suite = await loadSuite(suitePath);
  const adapter = platform === "codex" ? new CodexAdapter(process.env.SKILLBENCHMARK_CODEX_COMMAND || "codex") : platform === "claude-code" ? new ClaudeCodeAdapter(process.env.SKILLBENCHMARK_CLAUDE_COMMAND || "claude") : null;
  if (!adapter) throw new Error(`unsupported adapter: ${platform}`);
  const capability = await adapter.probe();
  if (capability.status === "unsupported") throw new Error(`${platform} adapter is unsupported: ${capability.evidence.join("; ")}`);
  const profile = { profile_id: platform, platform, platform_version: capability.version ?? "unknown", adapter_version: "0.1", model: "default", config_digest: sha256(`${platform}:${capability.version ?? "unknown"}`), capabilities: capability.capabilities };
  const runPlan = createRunPlan(suite, { repeats: 1, profiles: [profile] });
  const store = new SqliteStore(join(outputDir, "metadata.sqlite"), join(outputDir, "objects"));
  let report: ReturnType<typeof attachStatistics> | null = null;
  try {
    report = attachStatistics(await executePlanAsync(suite, runPlan, adapter, new LocalEnvironmentBackend(join(outputDir, "work")), store, { skill_dir: resolve(skillDir), load_method: "explicit-file-read" }));
    store.saveReport(report);
    await writeRunArtifacts(outputDir, runPlan, report);
  } finally {
    store.close();
  }
  if (!report) throw new Error("adapter run did not produce a report");
  console.log(`run=${report.run_id} status=${report.gate?.status ?? "unscored"}`);
}

async function evolve(suitePath: string, skillDir: string, outputDir: string): Promise<void> {
  const suite = await loadSuite(suitePath);
  const runPlan = createRunPlan(suite, { split: "train", repeats: 1 });
  const report = attachStatistics(executePlan(suite, runPlan));
  const evidence = buildEvidenceView(suite, report, "train");
  const patterns = maintainWiki(evidence);
  const parent = await importSkillSnapshot(skillDir, "incumbent");
  const candidate = patterns[0] ? await createCandidateSnapshot(skillDir, parent, patterns[0], join(outputDir, "candidate")) : null;
  if (candidate) {
    const validationPlan = createRunPlan(suite, { split: "validation", repeats: 1 });
    const validationReport = attachStatistics(executePlan(suite, validationPlan));
    candidate.proposal = applyValidationGate(candidate.proposal, validationReport.gate ?? { decision_id: "missing", comparison_refs: [], policy: defaultGatePolicy, status: "inconclusive", reasons: ["validation gate missing"] });
  }
  await writeEvolutionArtifacts(outputDir, evidence, patterns, candidate?.proposal);
  console.log(`evidence=${evidence.items.length} patterns=${patterns.length}${candidate ? ` proposal=${candidate.proposal.proposal_id}` : ""}`);
}

async function release(args: string[]): Promise<void> {
  const [action, first, second, third, fourth] = args;
  if (action === "publish") {
    if (!first || !second || !third) throw new Error("release publish 需要 skill-dir、gate.json 和 registry-dir");
    const snapshot = await importSkillSnapshot(first, "release");
    const gate = JSON.parse(await readFile(resolve(second), "utf8"));
    const registry = new FileRegistry(third);
    await registry.open();
    const releaseResult = await registry.publish(snapshot, first, gate, gate.comparison_refs ?? [], ["local"], registry.currentDigest());
    console.log(JSON.stringify(releaseResult, null, 2));
    return;
  }
  if (action === "export") {
    if (!first || !second || !third || !fourth) throw new Error("release export 需要 registry-dir、release-id、platform 和 output-dir");
    const registry = new FileRegistry(first);
    await registry.open();
    console.log(JSON.stringify(await registry.exportRelease(second, third, fourth), null, 2));
    return;
  }
  if (action === "rollback") {
    if (!first || !second) throw new Error("release rollback 需要 registry-dir 和 release-id");
    const registry = new FileRegistry(first);
    await registry.open();
    await registry.rollback(second, third);
    console.log(`rolled back to ${registry.currentDigest()}`);
    return;
  }
  throw new Error(`未知 release 命令：${action}`);
}

async function main(): Promise<void> {
  const [command, arg, outputArg] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return console.log(usage);
  if (command === "ui") {
    const options = uiOptions(process.argv.slice(3));
    const workspaceRoot = resolveWorkspaceRoot({ explicit: options.workspace, initCwd: process.env.INIT_CWD, cwd: process.cwd() });
    const agentCommands = { ...(process.env.SKILLBENCHMARK_CODEX_COMMAND ? { codex: process.env.SKILLBENCHMARK_CODEX_COMMAND } : {}), ...(process.env.SKILLBENCHMARK_CLAUDE_COMMAND ? { "claude-code": process.env.SKILLBENCHMARK_CLAUDE_COMMAND } : {}) };
    const workbench = await startLocalWorkbench({ workspaceRoot, port: options.port, openBrowser: options.openBrowser, agentCommands });
    console.log(`SkillBenchmark 工作台已启动：${workbench.browserUrl}`);
    console.log(`工作区：${workspaceRoot}`);
    return;
  }
  if (command === "demo") return run(demoSuite, resolve(root, ".skillbenchmark/runs/demo"));
  if (command === "skill" && arg === "import") {
    if (!outputArg) throw new Error("skill import 需要 skill-dir");
    console.log(JSON.stringify(await importSkillSnapshot(outputArg), null, 2));
    return;
  }
  if (command === "suite" && arg === "import") {
    if (!outputArg) throw new Error("suite import 需要 suite.json");
    console.log(JSON.stringify(await loadSuite(outputArg), null, 2));
    return;
  }
  if (command === "snapshot") {
    if (!arg) throw new Error("snapshot 需要 Skill 目录");
    console.log(JSON.stringify(await importSkillSnapshot(arg), null, 2));
    return;
  }
  if (command === "profile" && arg === "inspect") {
    const adapter = outputArg === "codex" ? new CodexAdapter() : outputArg === "claude-code" ? new ClaudeCodeAdapter() : null;
    if (!adapter) throw new Error("profile inspect 需要 codex 或 claude-code");
    console.log(JSON.stringify(await adapter.probe(), null, 2));
    return;
  }
  if (command === "run-adapter") {
    const [platform, suitePath, skillDir, output] = process.argv.slice(3);
    if (!platform || !suitePath || !skillDir) throw new Error("run-adapter 需要平台、suite.json 和 skill-dir");
    return runAdapter(platform, suitePath, skillDir, resolve(output ?? ".skillbenchmark/runs/adapter"));
  }
  if (command === "evolve") {
    if (!arg || !outputArg) throw new Error("evolve 需要 suite.json、skill-dir 和 output-dir");
    return evolve(resolve(arg), resolve(outputArg), resolve(process.argv[5] ?? ".skillbenchmark/evolution/latest"));
  }
  if (command === "proposal" && arg === "show") {
    if (!outputArg) throw new Error("proposal show 需要 proposal.json");
    console.log(await readFile(resolve(outputArg), "utf8"));
    return;
  }
  if (command === "report" || command === "compare") {
    if (!arg) throw new Error("report 需要 report.json 路径");
    const report = JSON.parse(await readFile(resolve(arg), "utf8"));
    console.log(JSON.stringify({ run_id: report.run_id, gate: report.gate?.status ?? null, summary: report.summary, comparisons: report.comparisons ?? [] }, null, 2));
    return;
  }
  if (command === "release") return release(process.argv.slice(3));
  if (command === "plan" || command === "run") {
    if (!arg) throw new Error(`${command} 需要 suite.json 路径`);
    const output = resolve(outputArg ?? ".skillbenchmark/runs/latest");
    return command === "plan" ? plan(resolve(arg), output) : run(resolve(arg), output);
  }
  throw new Error(`未知命令：${command}\n${usage}`);
}

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
