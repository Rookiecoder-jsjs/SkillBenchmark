import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRunPlan } from "../../../packages/core/src/plan.ts";
import { executePlan } from "../../../packages/core/src/pipeline.ts";
import { loadSuite } from "../../../packages/core/src/suite.ts";
import { attachStatistics } from "../../../packages/core/src/statistics.ts";
import { writeRunArtifacts } from "../../../packages/core/src/storage.ts";
import { SqliteStore } from "../../../packages/core/src/storage.ts";
import { applyValidationGate, buildEvidenceView, createCandidateSnapshot, maintainWiki, writeEvolutionArtifacts } from "../../../packages/core/src/evolution.ts";
import { importSkillSnapshot } from "../../../packages/core/src/snapshot.ts";
import { FileRegistry } from "../../../packages/core/src/registry.ts";

export interface RpcRequest { jsonrpc?: string; id?: string | number | null; method: string; params?: Record<string, unknown>; }

const DEFAULT_MAX_REQUEST_BYTES = 1 * 1024 * 1024;

async function* readLines(input: NodeJS.ReadableStream, maxBytes: number): AsyncGenerator<string | null> {
  input.setEncoding?.("utf8");
  let fragments: string[] = [];
  let bufferedBytes = 0;
  let oversized = false;
  const reset = (): void => { fragments = []; bufferedBytes = 0; oversized = false; };
  const append = (fragment: string): void => {
    const bytes = Buffer.byteLength(fragment);
    if (oversized) return;
    if (bufferedBytes + bytes > maxBytes) {
      reset();
      oversized = true;
      return;
    }
    fragments.push(fragment);
    bufferedBytes += bytes;
  };
  for await (const chunk of input as AsyncIterable<string | Buffer>) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline < 0) {
        append(text.slice(offset));
        break;
      }
      append(text.slice(offset, newline));
      if (oversized) yield null;
      else {
        const raw = fragments.join("");
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim()) yield line;
      }
      reset();
      offset = newline + 1;
    }
  }
  if (oversized) yield null;
  else if (fragments.length) {
    const line = fragments.join("");
    if (line.trim()) yield line;
  }
}

async function writeResponse(response: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify(response)}\n`;
  if (process.stdout.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    process.stdout.once("drain", resolve);
    process.stdout.once("error", reject);
  });
}

export async function handleRequest(request: RpcRequest): Promise<Record<string, unknown>> {
  if (request.method === "initialize") return { jsonrpc: "2.0", id: request.id ?? null, result: { protocolVersion: "2024-11-05", serverInfo: { name: "skillbenchmark", version: "0.1.0" }, capabilities: { tools: {} } } };
  if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: [
    { name: "skillbenchmark_plan", description: "Generate a frozen experiment plan", inputSchema: { type: "object", required: ["suite_path", "output_dir"] } },
    { name: "skillbenchmark_run", description: "Run the deterministic local mock evaluation", inputSchema: { type: "object", required: ["suite_path", "output_dir"] } },
    { name: "skillbenchmark_report", description: "Read a generated run report", inputSchema: { type: "object", required: ["report_path"] } },
    { name: "skillbenchmark_compare", description: "Read comparisons and gate decision from a run report", inputSchema: { type: "object", required: ["report_path"] } },
    { name: "skillbenchmark_evolve", description: "Build train EvidenceView, Wiki and a candidate Skill", inputSchema: { type: "object", required: ["suite_path", "skill_dir", "output_dir"] } },
    { name: "skillbenchmark_publish", description: "Publish an accepted Skill release", inputSchema: { type: "object", required: ["skill_dir", "gate_path", "registry_dir"] } },
    { name: "skillbenchmark_export", description: "Export a published Skill release for a platform", inputSchema: { type: "object", required: ["registry_dir", "release_id", "platform", "output_dir"] } },
    { name: "skillbenchmark_rollback", description: "Roll back the registry pointer", inputSchema: { type: "object", required: ["registry_dir", "release_id"] } },
  ] } };
  const params = request.params ?? {};
  if (request.method !== "tools/call") return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: `method not found: ${request.method}` } };
  const name = String(params.name ?? "");
  const argumentsValue = (params.arguments ?? {}) as Record<string, unknown>;
  if (name === "skillbenchmark_report" || name === "skillbenchmark_compare") {
    const reportPath = String(argumentsValue.report_path ?? "");
    if (!reportPath) return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "report_path is required" } };
    const report = JSON.parse(await readFile(resolve(reportPath), "utf8")) as { run_id: string; gate?: { status: string }; summary: unknown; comparisons?: unknown[] };
    return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ run_id: report.run_id, gate: report.gate?.status ?? null, summary: name === "skillbenchmark_report" ? report.summary : undefined, comparisons: report.comparisons ?? [] }) }] } };
  }
  if (name === "skillbenchmark_publish") {
    const skillDir = String(argumentsValue.skill_dir ?? "");
    const gatePath = String(argumentsValue.gate_path ?? "");
    const registryDir = String(argumentsValue.registry_dir ?? "");
    if (!skillDir || !gatePath || !registryDir) return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "skill_dir, gate_path and registry_dir are required" } };
    const registry = new FileRegistry(registryDir);
    await registry.open();
    const release = await registry.publish(await importSkillSnapshot(skillDir, "mcp-release"), skillDir, JSON.parse(await readFile(resolve(gatePath), "utf8")), [], ["local"], registry.currentDigest());
    return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(release) }] } };
  }
  if (name === "skillbenchmark_export") {
    const registry = new FileRegistry(String(argumentsValue.registry_dir ?? ""));
    await registry.open();
    const receipt = await registry.exportRelease(String(argumentsValue.release_id ?? ""), String(argumentsValue.platform ?? ""), String(argumentsValue.output_dir ?? ""));
    return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(receipt) }] } };
  }
  if (name === "skillbenchmark_rollback") {
    const registry = new FileRegistry(String(argumentsValue.registry_dir ?? ""));
    await registry.open();
    await registry.rollback(String(argumentsValue.release_id ?? ""), argumentsValue.expected_current_digest === undefined ? undefined : String(argumentsValue.expected_current_digest));
    return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ current_digest: registry.currentDigest() }) }] } };
  }
  const suitePath = String(argumentsValue.suite_path ?? "");
  const outputDir = resolve(String(argumentsValue.output_dir ?? ".skillbenchmark/mcp"));
  if (!suitePath) return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "suite_path is required" } };
  const suite = await loadSuite(resolve(suitePath));
  if (name === "skillbenchmark_evolve") {
    const skillDir = String(argumentsValue.skill_dir ?? "");
    if (!skillDir) return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "skill_dir is required" } };
    const plan = createRunPlan(suite, { split: "train", repeats: 1 });
    const report = attachStatistics(executePlan(suite, plan));
    const evidence = buildEvidenceView(suite, report, "train");
    const patterns = maintainWiki(evidence);
    const parent = await importSkillSnapshot(skillDir, "mcp-incumbent");
    const candidate = patterns[0] ? await createCandidateSnapshot(skillDir, parent, patterns[0], join(outputDir, "candidate")) : null;
    if (candidate) {
      const validationReport = attachStatistics(executePlan(suite, createRunPlan(suite, { split: "validation", repeats: 1 })));
      if (validationReport.gate) candidate.proposal = applyValidationGate(candidate.proposal, validationReport.gate);
    }
    await writeEvolutionArtifacts(outputDir, evidence, patterns, candidate?.proposal);
    return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ output_dir: outputDir, proposal_id: candidate?.proposal.proposal_id ?? null }) }] } };
  }
  const plan = createRunPlan(suite, { repeats: 1 });
  if (name === "skillbenchmark_plan") {
    await writeRunArtifacts(outputDir, plan);
    return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ run_id: plan.run_id, trial_count: plan.trials.length, output_dir: outputDir }) }] } };
  }
  if (name === "skillbenchmark_run") {
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
    return { jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ run_id: report.run_id, gate: report.gate?.status, output_dir: outputDir }) }] } };
  }
  return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: `unknown tool: ${name}` } };
}

if (import.meta.main) {
  const configuredMax = Number(process.env.SKILLBENCHMARK_MCP_MAX_REQUEST_BYTES);
  const maxRequestBytes = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_REQUEST_BYTES;
  const runStdio = async (): Promise<void> => {
    for await (const line of readLines(process.stdin, maxRequestBytes)) {
      if (line === null) {
        await writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request exceeds ${maxRequestBytes} bytes` } });
        continue;
      }
      try { await writeResponse(await handleRequest(JSON.parse(line) as RpcRequest)); }
      catch (error) { await writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }); }
    }
  };
  runStdio().catch((error) => { process.stderr.write(`MCP server stopped: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
