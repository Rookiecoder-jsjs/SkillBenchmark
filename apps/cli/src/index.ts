import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createRunPlan } from "../../../packages/core/src/plan.ts";
import { executePlan } from "../../../packages/core/src/pipeline.ts";
import { importSkillSnapshot } from "../../../packages/core/src/snapshot.ts";
import { loadSuite } from "../../../packages/core/src/suite.ts";
import { writeRunArtifacts } from "../../../packages/core/src/storage.ts";

const root = resolve(import.meta.dirname, "../../../");
const demoSuite = resolve(root, "suites/smoke/suite.json");
const usage = `SkillBenchmark v0.1\n\n用法:\n  npm run demo                         运行内置 smoke Suite\n  npm run skillbenchmark -- plan <suite.json> [output-dir]\n  npm run skillbenchmark -- run <suite.json> [output-dir]\n  npm run skillbenchmark -- snapshot <skill-dir>\n`;

async function run(suitePath: string, outputDir: string): Promise<void> {
  const suite = await loadSuite(suitePath);
  const plan = createRunPlan(suite, { repeats: 1 });
  const report = executePlan(suite, plan);
  await writeRunArtifacts(outputDir, plan, report);
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

async function main(): Promise<void> {
  const [command, arg, outputArg] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return console.log(usage);
  if (command === "demo") return run(demoSuite, resolve(root, ".skillbenchmark/runs/demo"));
  if (command === "snapshot") {
    if (!arg) throw new Error("snapshot 需要 Skill 目录");
    console.log(JSON.stringify(await importSkillSnapshot(arg), null, 2));
    return;
  }
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
