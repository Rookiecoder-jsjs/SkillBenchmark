import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunPlan, RunReport } from "../../contracts/src/types.ts";
import { renderMarkdown } from "./pipeline.ts";

export async function writeRunArtifacts(outputDir: string, plan: RunPlan, report?: RunReport): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  if (report) {
    await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(outputDir, "report.md"), renderMarkdown(report));
  }
}
